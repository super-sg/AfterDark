'use strict';

/**
 * Media enrichment.
 *
 * Every card in the feed wants a picture. We do not host media, so the picture
 * has to come from the linked page's own Open Graph image — the same mechanism
 * X and Reddit use to build link cards, and the reason a link card earns
 * multiples of the engagement of a bare URL.
 *
 * Three jobs live here:
 *   1. Recognise video URLs and turn them into an embeddable id.
 *   2. Fetch a page's OG/Twitter-card metadata, safely.
 *   3. Refuse to touch anything on a private network (SSRF).
 */

const dns = require('node:dns').promises;
const net = require('node:net');

const USER_AGENT =
  'AfterDarkBot/1.0 (+https://example.com/about; link preview generation)';
const HTML_TIMEOUT_MS = 9000;
// Ceiling for a page fetch. We stop at </head> long before this in practice;
// this is the backstop for a page that never closes its head.
const MAX_HTML_BYTES = 2 * 1024 * 1024;

// ---------------------------------------------------------------------------
// SSRF protection
// ---------------------------------------------------------------------------

/**
 * A URL that a user supplies is an instruction to make an outbound request
 * from inside our network. Every private range has to be off limits, and the
 * check has to happen after DNS resolution or `evil.com A 127.0.0.1` walks
 * straight through it.
 */
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||   // CGNAT
      (a === 169 && b === 254) ||             // link-local / cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224                                 // multicast + reserved
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1') return true;
    if (v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd')) return true;
    // IPv4-mapped addresses must be re-checked as IPv4.
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true; // unparseable — refuse
}

/** @returns {Promise<URL>} the validated URL, or throws. */
async function assertPublicUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw new Error('malformed URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`refusing protocol ${url.protocol}`);
  }
  if (url.username || url.password) throw new Error('credentials in URL');

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error('private address');
    return url;
  }
  if (/\.(?:local|internal|localhost|home\.arpa)$/i.test(host) || host === 'localhost') {
    throw new Error('private hostname');
  }

  const records = await dns.lookup(host, { all: true, verbatim: true });
  if (!records.length) throw new Error('DNS failure');
  for (const { address } of records) {
    if (isPrivateAddress(address)) throw new Error(`resolves to private address ${address}`);
  }
  return url;
}

const MAX_REDIRECTS = 4;

/** fetch() with SSRF validation, a timeout, and a hard byte ceiling. */
async function safeFetch(rawUrl, { maxBytes, timeoutMs, accept, stopAfter, depth = 0 } = {}) {
  if (depth > MAX_REDIRECTS) throw new Error('too many redirects');
  const url = await assertPublicUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || HTML_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'manual', // follow by hand so every hop is re-validated
      headers: { 'user-agent': USER_AGENT, accept: accept || '*/*' },
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new Error(`redirect without location (${res.status})`);
      const next = new URL(location, url).toString();
      clearTimeout(timer);
      // Re-enter through the front door so the new host is validated too.
      return safeFetch(next, { maxBytes, timeoutMs, accept, stopAfter, depth: depth + 1 });
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const declared = Number(res.headers.get('content-length') || 0);
    const cap = maxBytes || MAX_HTML_BYTES;
    if (declared && declared > cap) throw new Error(`too large (${declared} bytes)`);

    // Read incrementally so a server that lies about content-length cannot
    // stream us an unbounded body.
    //
    // `stopAfter` lets a caller quit early: OG tags live in <head>, and a news
    // article's full HTML routinely runs past a megabyte of body copy that we
    // would only throw away. Bailing at </head> is the difference between this
    // working and failing on most real publishers.
    const chunks = [];
    let total = 0;
    let tail = '';
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > cap) {
        if (stopAfter) break; // partial head is still worth parsing
        throw new Error('exceeded byte ceiling mid-stream');
      }
      chunks.push(chunk);
      if (stopAfter) {
        // Keep a small overlap so the marker is still found when it straddles
        // a chunk boundary.
        tail = (tail + chunk.toString('latin1')).slice(-2048);
        if (tail.toLowerCase().includes(stopAfter)) break;
      }
    }

    return {
      buffer: Buffer.concat(chunks),
      contentType: (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(),
      finalUrl: url.toString(),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Video recognition
// ---------------------------------------------------------------------------

/**
 * Recognised video hosts become click-to-play embeds. Anything else is a plain
 * link — we do not proxy arbitrary video.
 * @returns {{kind:string, id:string, poster:string, embedUrl:string}|null}
 */
function parseVideo(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, '').toLowerCase();

  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
    const id = url.searchParams.get('v') || url.pathname.match(/\/(?:shorts|embed|v)\/([\w-]{6,15})/)?.[1];
    if (id) return youtube(id);
  }
  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0];
    if (/^[\w-]{6,15}$/.test(id)) return youtube(id);
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const id = url.pathname.match(/(\d{6,12})/)?.[1];
    if (id) {
      return {
        kind: 'vimeo',
        id,
        poster: '', // resolved from the page's OG image
        embedUrl: `https://player.vimeo.com/video/${id}?autoplay=1&dnt=1`,
      };
    }
  }
  return null;
}

function youtube(id) {
  return {
    kind: 'youtube',
    id,
    // maxres is not always present; hq is. The proxy falls back if it 404s.
    poster: `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`,
    posterFallback: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    // nocookie + no autoplay-on-load: the iframe is only injected on click.
    embedUrl: `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&modestbranding=1`,
  };
}

// ---------------------------------------------------------------------------
// Open Graph / Twitter card extraction
// ---------------------------------------------------------------------------

function decodeEntities(str) {
  return String(str)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

/** Pull every <meta> into a lookup keyed by name/property, lowercased. */
function parseMetaTags(html) {
  const head = html.slice(0, html.search(/<\/head>/i) + 1 || html.length);
  const tags = head.match(/<meta\b[^>]*>/gi) || [];
  const out = new Map();

  for (const tag of tags) {
    const key = (
      tag.match(/\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i)?.[1] || ''
    ).toLowerCase().trim();
    const value = tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i)?.[1];
    if (key && value && !out.has(key)) out.set(key, decodeEntities(value).trim());
  }
  return out;
}

/**
 * @returns {Promise<{title,description,image,imageAlt,siteName,publishedAt,video}>}
 */
async function fetchPageMeta(rawUrl) {
  const { buffer, finalUrl } = await safeFetch(rawUrl, {
    maxBytes: MAX_HTML_BYTES,
    accept: 'text/html,application/xhtml+xml',
    stopAfter: '</head>',
  });
  const html = buffer.toString('utf8');
  const meta = parseMetaTags(html);

  const pick = (...keys) => {
    for (const k of keys) {
      const v = meta.get(k);
      if (v) return v;
    }
    return '';
  };

  const absolute = (href) => {
    if (!href) return '';
    try {
      return new URL(href, finalUrl).toString();
    } catch {
      return '';
    }
  };

  const titleTag = html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i)?.[1];

  return {
    title: pick('og:title', 'twitter:title') || decodeEntities(titleTag || '').trim(),
    description: pick('og:description', 'twitter:description', 'description'),
    image: absolute(pick('og:image:secure_url', 'og:image:url', 'og:image', 'twitter:image', 'twitter:image:src')),
    imageAlt: pick('og:image:alt', 'twitter:image:alt'),
    imageWidth: Number(pick('og:image:width')) || 0,
    imageHeight: Number(pick('og:image:height')) || 0,
    siteName: pick('og:site_name', 'application-name'),
    publishedAt: Date.parse(pick('article:published_time', 'og:updated_time', 'date')) || 0,
    video: absolute(pick('og:video:secure_url', 'og:video:url', 'og:video')),
    cardType: pick('twitter:card'),
    finalUrl,
  };
}

/**
 * Enrich a link: recognise video, then fill in the poster/preview from the
 * page's own metadata. Never throws — a card without a picture is a worse
 * card, not a failed request.
 */
async function enrichLink(rawUrl) {
  const result = {
    imageUrl: '', imageWidth: 0, imageHeight: 0, imageAlt: '',
    videoKind: '', videoId: '', siteName: '', description: '', publishedAt: 0,
  };

  const video = parseVideo(rawUrl);
  if (video) {
    result.videoKind = video.kind;
    result.videoId = video.id;
    result.imageUrl = video.poster || '';
  }

  try {
    const meta = await fetchPageMeta(rawUrl);
    if (meta.image && !result.imageUrl) result.imageUrl = meta.image;
    if (meta.image && video && video.kind === 'vimeo') result.imageUrl = meta.image;
    result.imageWidth = meta.imageWidth;
    result.imageHeight = meta.imageHeight;
    result.imageAlt = meta.imageAlt;
    result.siteName = meta.siteName;
    result.description = meta.description;
    result.publishedAt = meta.publishedAt;
  } catch {
    // Metadata is a bonus. A YouTube poster still stands on its own.
  }

  return result;
}

module.exports = {
  assertPublicUrl,
  isPrivateAddress,
  safeFetch,
  parseVideo,
  parseMetaTags,
  fetchPageMeta,
  enrichLink,
  USER_AGENT,
};
