'use strict';

/**
 * The Wire — pulls headlines, artwork and trending-video metadata from external
 * sources into the boards.
 *
 * What crosses the boundary: a title, a link, a timestamp, a short summary, the
 * publisher's own thumbnail URL and — for video sources — duration, view count
 * and tags. What does not: article bodies and media files. The story stays on
 * the publisher's site, where the attribution and the ad revenue belong, and
 * every picture is fetched through our signed proxy at render time rather than
 * mirrored into our storage.
 *
 * Before any request we read the publisher's robots.txt and honour it, and we
 * identify ourselves in the User-Agent. Check each publisher's terms before
 * enabling their source commercially.
 */

const { posts, boards } = require('./store');
const { clean, screen } = require('./moderation');
const { parseFeed, parseJson } = require('./feedparse');
const sources = require('./sources');
const robots = require('./robots');
const topics = require('./topics');

const FETCH_TIMEOUT_MS = 12000;
const MAX_ITEMS_PER_SOURCE = 30;
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * Does this item belong on the board its source targets?
 *
 * Only asked of sources that declared a filter — general publications that
 * cover the subject alongside everything else. Matching is a plain substring
 * test over the headline, summary and tags: cheap, predictable, and easy for an
 * operator to reason about when a term is added or removed.
 *
 * @param {{filter?: string[]}} source
 * @param {{title:string, summary:string, tags:string[]}} item
 */
function isRelevant(source, item) {
  if (!source.filter || !source.filter.length) return true;
  const haystack = `${item.title} ${item.summary} ${item.tags.join(' ')}`.toLowerCase();
  return source.filter.some((term) => haystack.includes(term.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/**
 * Fetch one source, honouring robots.txt and a hard byte ceiling.
 * A server that opens a stream and never closes it should cost us a timeout,
 * not a worker, so the body read is raced against the same deadline.
 */
async function fetchSource(source) {
  const verdict = await robots.check(source.url, sources.USER_AGENT);
  if (!verdict.allowed) {
    const err = new Error('disallowed by robots.txt');
    err.code = 'ROBOTS';
    throw err;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(source.url, {
      signal: controller.signal,
      headers: {
        'user-agent': sources.USER_AGENT,
        accept: source.adapter === 'json'
          ? 'application/json, text/javascript, */*'
          : 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const body = await readCapped(res, MAX_BYTES);
    if (source.adapter === 'json') {
      let json;
      try {
        json = JSON.parse(body);
      } catch {
        throw new Error('response was not JSON (a filter or login wall usually returns HTML here)');
      }
      return parseJson(json, { itemsPath: source.itemsPath, map: source.map || {} });
    }
    return parseFeed(body);
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(res, maxBytes) {
  if (!res.body) return res.text();
  const decoder = new TextDecoder('utf-8');
  let out = '';
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > maxBytes) {
      out += decoder.decode(chunk.subarray(0, Math.max(0, chunk.length - (total - maxBytes))));
      break;
    }
    out += decoder.decode(chunk, { stream: true });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

/**
 * Pull every enabled source and insert anything new.
 *
 * One dead source must never stop the others, so failures are settled rather
 * than thrown and recorded against the source row — an operator can then see
 * from `npm run wire` or the admin panel exactly which publishers are
 * reachable from wherever this is deployed.
 *
 * @returns {Promise<{added:number, skipped:number, blocked:number, errors:Array, perSource:Array}>}
 */
async function ingest({ only = null, log = () => {} } = {}) {
  const summary = { added: 0, skipped: 0, blocked: 0, blockedTitles: [], errors: [], perSource: [] };

  let list = sources.enabled();
  if (only) {
    const wanted = new Set([].concat(only));
    list = list.filter((s) => wanted.has(s.id));
  }
  if (!list.length) return summary;

  const boardCache = new Map();
  const boardFor = (slug) => {
    if (!boardCache.has(slug)) boardCache.set(slug, boards.bySlug(slug) || boards.bySlug('newsroom'));
    return boardCache.get(slug);
  };

  const results = await Promise.all(
    list.map((s) => fetchSource(s).then((items) => ({ s, items }), (error) => ({ s, error })))
  );

  for (const { s, items, error } of results) {
    if (error) {
      const reason = error?.name === 'AbortError'
        ? `timed out after ${FETCH_TIMEOUT_MS}ms`
        : String(error?.message || error);
      summary.errors.push({ source: s.name, id: s.id, url: s.url, error: reason });
      summary.perSource.push({ id: s.id, name: s.name, kind: s.kind, status: 'error', error: reason, seen: 0, added: 0 });
      sources.report(s.id, { status: error?.code === 'ROBOTS' ? 'robots' : 'error', error: reason });
      log(`✗ ${s.name}: ${reason}`);
      continue;
    }

    const board = boardFor(s.board);
    if (!board) {
      const reason = `target board "${s.board}" missing — run \`npm run seed\``;
      summary.errors.push({ source: s.name, id: s.id, error: reason });
      summary.perSource.push({ id: s.id, name: s.name, kind: s.kind, status: 'error', error: reason, seen: items.length, added: 0 });
      sources.report(s.id, { status: 'error', error: reason, seen: items.length });
      continue;
    }

    let added = 0;
    let offTopic = 0;
    for (const item of items.slice(0, MAX_ITEMS_PER_SOURCE)) {
      if (!item.title || !item.link) continue;
      if (!isRelevant(s, item)) {
        offTopic++;
        continue;
      }

      const guid = `${s.id}:${item.guid || item.link}`.slice(0, 400);
      if (posts.wireExists(guid)) {
        summary.skipped++;
        continue;
      }

      const title = clean(item.title, 300);
      const body = clean(item.summary, 1200);
      const verdict = screen(title, body, item.tags.join(' '));
      if (!verdict.ok) {
        // Name what was dropped: a screened-out trade headline is usually a
        // filter false positive worth a human look, not a silent skip.
        summary.blocked++;
        summary.blockedTitles.push(`[${s.name}] ${title}`);
        log(`✗ blocked by filter: [${s.name}] ${title}`);
        continue;
      }

      try {
        const postId = posts.create({
          boardId: board.id,
          authorId: null,
          kind: s.kind === 'video' ? 'video' : 'article',
          title,
          body,
          url: item.link,
          flair: s.kind === 'video' ? 'Trending' : 'Wire',
          sourceName: s.name,
          sourceUrl: item.link,
          sourceId: s.id,
          wireGuid: guid,
          publishedAt: item.publishedAt,
          // A picture that came with the feed needs no separate page fetch.
          imageUrl: item.image,
          imageAlt: item.imageAlt || title,
          imageW: item.imageW,
          imageH: item.imageH,
          duration: item.duration,
          views: item.views,
          nsfw: s.nsfw,
        });
        // A tube-site keyword describes what is in a clip; a publisher category
        // describes what a story is about. Only the second belongs in a news
        // trends list, so they are filed under different kinds.
        topics.attach(postId, {
          title,
          tags: item.tags,
          tagKind: s.kind === 'video' ? 'content' : 'tag',
        });
        summary.added++;
        added++;
        log(`+ [${s.name}] ${title}${item.image ? ' 🖼' : ''}${item.duration ? ` ${item.duration}s` : ''}`);
      } catch (err) {
        // A UNIQUE violation just means another worker won the race.
        if (String(err.message).includes('UNIQUE')) summary.skipped++;
        else summary.errors.push({ source: s.name, id: s.id, error: String(err.message) });
      }
    }

    if (offTopic) log(`  ${s.name}: ${offTopic} item${offTopic === 1 ? '' : 's'} off-topic for r/${s.board}`);
    summary.perSource.push({
      id: s.id, name: s.name, kind: s.kind, status: 'ok', error: '',
      seen: items.length, added, offTopic,
    });
    sources.report(s.id, { status: 'ok', seen: items.length, added });
  }

  return summary;
}

module.exports = { ingest, fetchSource, parseFeed, isRelevant };
