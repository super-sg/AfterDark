'use strict';

/**
 * Feed parsing.
 *
 * Two adapters, one output shape. RSS/Atom is handled by a small tolerant
 * parser — feeds are regular enough that this beats pulling in an XML stack,
 * and being tolerant matters more than being correct when publishers ship
 * malformed markup daily. JSON APIs are handled by a declarative field map, so
 * a source whose response shape drifts is a config edit rather than a patch.
 *
 * The important addition over a plain headline reader is media: most feeds
 * already carry their own artwork in `media:content`, `media:thumbnail` or an
 * `<enclosure>`, and a picture taken from the feed costs nothing where scraping
 * the article page for an Open Graph tag costs a whole HTTP round trip.
 *
 * @typedef {object} FeedItem
 * @property {string} title
 * @property {string} link
 * @property {string} guid
 * @property {string} summary
 * @property {number} publishedAt
 * @property {string} image
 * @property {number} imageW
 * @property {number} imageH
 * @property {string} imageAlt
 * @property {number} duration  seconds, 0 when unknown
 * @property {number} views
 * @property {string[]} tags
 */

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

function decodeEntities(str) {
  return String(str)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function stripTags(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decodeEntities(m[1]).trim() : '';
}

/** Read an attribute off the first element with the given name. */
function attrOf(xml, element, attribute) {
  const el = xml.match(new RegExp(`<${element}\\b[^>]*>`, 'i'));
  if (!el) return '';
  const m = el[0].match(new RegExp(`${attribute}\\s*=\\s*["']([^"']*)["']`, 'i'));
  return m ? decodeEntities(m[1]) : '';
}

/** Every element with the given name, as raw opening tags. */
function elements(xml, element) {
  return xml.match(new RegExp(`<${element}\\b[^>]*>`, 'gi')) || [];
}

function attr(openTag, attribute) {
  const m = openTag.match(new RegExp(`${attribute}\\s*=\\s*["']([^"']*)["']`, 'i'));
  return m ? decodeEntities(m[1]) : '';
}

function linkOf(xml) {
  const rss = tag(xml, 'link');
  if (rss && /^https?:/i.test(rss)) return rss;
  const atom = xml.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)
    || xml.match(/<link[^>]*href=["']([^"']+)["']/i);
  return atom ? decodeEntities(atom[1]) : '';
}

const IMAGE_EXT = /\.(jpe?g|png|webp|avif|gif)(\?|#|$)/i;
const isHttp = (u) => /^https?:\/\//i.test(u || '');

/**
 * Pull the best picture out of a feed item.
 *
 * Order matters: an explicit media element is the publisher saying "this is the
 * artwork", while an image scraped out of the description is a guess that might
 * be a tracking pixel or a share button. Anything under 200px in a declared
 * dimension is rejected for exactly that reason.
 */
function imageOf(chunk) {
  const candidates = [];

  for (const el of elements(chunk, 'media:content')) {
    const url = attr(el, 'url');
    const type = attr(el, 'type');
    const medium = attr(el, 'medium');
    if (!isHttp(url)) continue;
    if (medium && medium !== 'image') continue;
    if (type && !/^image\//i.test(type)) continue;
    candidates.push({ url, w: Number(attr(el, 'width')) || 0, h: Number(attr(el, 'height')) || 0, rank: 0 });
  }
  for (const el of elements(chunk, 'media:thumbnail')) {
    const url = attr(el, 'url');
    if (isHttp(url)) candidates.push({ url, w: Number(attr(el, 'width')) || 0, h: Number(attr(el, 'height')) || 0, rank: 1 });
  }
  for (const el of elements(chunk, 'enclosure')) {
    const url = attr(el, 'url');
    if (isHttp(url) && (/^image\//i.test(attr(el, 'type')) || IMAGE_EXT.test(url))) {
      candidates.push({ url, w: 0, h: 0, rank: 2 });
    }
  }
  // itunes and Dublin Core variants used by a surprising number of blogs.
  const itunes = attrOf(chunk, 'itunes:image', 'href');
  if (isHttp(itunes)) candidates.push({ url: itunes, w: 0, h: 0, rank: 3 });

  // Last resort: the first plausible <img> inside the rendered body.
  const body = tag(chunk, 'content:encoded') || tag(chunk, 'description') || tag(chunk, 'content');
  for (const el of elements(body, 'img')) {
    const url = attr(el, 'src') || attr(el, 'data-src');
    if (!isHttp(url)) continue;
    const w = Number(attr(el, 'width')) || 0;
    const h = Number(attr(el, 'height')) || 0;
    if ((w && w < 200) || (h && h < 200)) continue; // spacer, badge or tracking pixel
    candidates.push({ url, w, h, rank: 4, alt: attr(el, 'alt') });
  }

  const best = candidates
    .filter((c) => !/\b(?:pixel|spacer|blank|1x1|avatar|gravatar|badge|button)\b/i.test(c.url))
    .sort((a, b) => a.rank - b.rank || (b.w * b.h) - (a.w * a.h))[0];

  return best
    ? { image: best.url, imageW: best.w, imageH: best.h, imageAlt: best.alt || '' }
    : { image: '', imageW: 0, imageH: 0, imageAlt: '' };
}

/** `PT1H2M3S`, `01:02:03`, `1:02` or a bare second count — all seen in the wild. */
function parseDuration(raw) {
  const text = String(raw || '').trim();
  if (!text) return 0;
  if (/^\d+$/.test(text)) return Number(text);

  const iso = text.match(/^P?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  if (iso && (iso[1] || iso[2] || iso[3])) {
    return Math.round((Number(iso[1] || 0) * 3600) + (Number(iso[2] || 0) * 60) + Number(iso[3] || 0));
  }
  const parts = text.split(':').map(Number);
  if (parts.length >= 2 && parts.every(Number.isFinite)) {
    return parts.reduce((total, part) => total * 60 + part, 0);
  }
  return 0;
}

function durationOf(chunk) {
  const explicit = tag(chunk, 'itunes:duration');
  if (explicit) return parseDuration(explicit);
  for (const el of elements(chunk, 'media:content')) {
    const d = attr(el, 'duration');
    if (d) return parseDuration(d);
  }
  return 0;
}

function tagsOf(chunk) {
  const out = [];
  for (const raw of chunk.match(/<category[^>]*>([\s\S]*?)<\/category>/gi) || []) {
    const text = stripTags(raw);
    if (text) out.push(text);
  }
  // Atom puts the value in an attribute rather than the element body.
  for (const el of elements(chunk, 'category')) {
    const term = attr(el, 'term');
    if (term) out.push(term);
  }
  for (const el of elements(chunk, 'media:keywords')) {
    const kw = attr(el, 'content');
    if (kw) out.push(...kw.split(','));
  }
  const keywords = tag(chunk, 'media:keywords');
  if (keywords) out.push(...keywords.split(','));
  return out;
}

/**
 * Parse an RSS 2.0, RSS 1.0 or Atom document.
 * @returns {FeedItem[]}
 */
function parseFeed(xml) {
  const chunks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
  return chunks.map((chunk) => {
    const dateStr = tag(chunk, 'pubDate') || tag(chunk, 'published')
      || tag(chunk, 'updated') || tag(chunk, 'dc:date');
    const parsed = dateStr ? Date.parse(dateStr) : NaN;
    const media = imageOf(chunk);
    return {
      title: stripTags(tag(chunk, 'title')),
      link: linkOf(chunk),
      guid: tag(chunk, 'guid') || tag(chunk, 'id') || linkOf(chunk),
      summary: stripTags(
        tag(chunk, 'description') || tag(chunk, 'summary')
        || tag(chunk, 'content:encoded') || tag(chunk, 'content')
      ),
      publishedAt: Number.isFinite(parsed) ? parsed : Date.now(),
      duration: durationOf(chunk),
      views: 0,
      tags: normaliseTags(tagsOf(chunk)),
      ...media,
    };
  });
}

// ---------------------------------------------------------------------------
// JSON adapter
// ---------------------------------------------------------------------------

/**
 * Read a dotted path out of an object. Supports one array projection with the
 * `field[].sub` form, which is how tag lists arrive from every video API.
 */
function pluck(obj, path) {
  if (!path) return undefined;
  let cursor = obj;
  for (const segment of String(path).split('.')) {
    if (cursor == null) return undefined;
    const projection = segment.match(/^(.+)\[\]$/);
    if (projection) {
      const arr = cursor[projection[1]];
      return Array.isArray(arr) ? arr : undefined;
    }
    cursor = cursor[segment];
  }
  return cursor;
}

/** `tags[].tag_name` — project a field out of each element. */
function pluckList(obj, path) {
  const idx = String(path).indexOf('[]');
  if (idx === -1) {
    const value = pluck(obj, path);
    if (Array.isArray(value)) return value.map(String);
    return typeof value === 'string' ? value.split(',') : [];
  }
  const arr = pluck(obj, path.slice(0, idx + 2));
  const rest = path.slice(idx + 3);
  if (!Array.isArray(arr)) return [];
  return arr.map((el) => (rest ? pluck(el, rest) : el)).filter((v) => typeof v === 'string' || typeof v === 'number').map(String);
}

function toTimestamp(value) {
  if (value == null || value === '') return Date.now();
  if (typeof value === 'number') return value < 1e11 ? value * 1000 : value; // seconds vs ms
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

const toInt = (v) => {
  const n = Number.parseInt(String(v ?? '').replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * Map a JSON API response into feed items using a source's declarative map.
 * @param {any} json
 * @param {{itemsPath?:string, map:object}} spec
 * @returns {FeedItem[]}
 */
function parseJson(json, spec) {
  const { itemsPath = '', map = {} } = spec || {};
  let items = itemsPath ? pluck(json, itemsPath) : json;
  if (!Array.isArray(items)) items = Array.isArray(json) ? json : [];

  return items.map((raw) => {
    const str = (key) => {
      const v = pluck(raw, map[key]);
      return v == null ? '' : String(v);
    };
    const link = str('link');
    return {
      title: stripTags(str('title')),
      link,
      guid: str('guid') || link,
      summary: stripTags(str('summary')),
      publishedAt: toTimestamp(pluck(raw, map.publishedAt)),
      image: isHttp(str('image')) ? str('image') : '',
      imageW: toInt(pluck(raw, map.imageW)),
      imageH: toInt(pluck(raw, map.imageH)),
      imageAlt: '',
      duration: parseDuration(pluck(raw, map.duration)),
      views: toInt(pluck(raw, map.views)),
      tags: normaliseTags(map.tags ? pluckList(raw, map.tags) : []),
    };
  }).filter((item) => item.title && isHttp(item.link));
}

// ---------------------------------------------------------------------------

const TAG_STOPWORDS = new Set(['uncategorized', 'uncategorised', 'news', 'featured', 'general', 'video', 'videos', 'hd', 'porn', 'sex', 'xxx', 'free']);

/** Trim, dedupe, drop noise, and cap. Tags drive topic pages, so quality matters. */
function normaliseTags(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list || []) {
    const text = String(raw).replace(/\s+/g, ' ').trim();
    if (text.length < 2 || text.length > 40) continue;
    const key = text.toLowerCase();
    if (TAG_STOPWORDS.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= 8) break;
  }
  return out;
}

module.exports = {
  parseFeed, parseJson, parseDuration, normaliseTags,
  stripTags, decodeEntities, pluck, pluckList, imageOf,
};
