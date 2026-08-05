'use strict';

/**
 * Source registry.
 *
 * Every external thing the site pulls in is declared here as data, never as
 * code: an adapter name, a URL, a target board, and — for JSON APIs — a
 * declarative field mapping. That means a publisher changing a field name is a
 * config edit, and an operator can add a source at runtime without a deploy.
 *
 * `verified` records whether the endpoint was reachable and correctly shaped
 * when this file was written. Sources marked false are documented endpoints
 * that could not be confirmed from the development machine, which sits behind a
 * network filter that intercepts adult domains — they are shipped enabled but
 * their health is reported honestly by `npm run wire`.
 */

const { db } = require('./db');

const USER_AGENT = process.env.WIRE_USER_AGENT
  || 'AfterDarkWire/2.0 (+https://example.com/about/wire; headline and metadata aggregation)';

// ---------------------------------------------------------------------------
// Declarative sources
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Source
 * @property {string}  id        stable key, also the dedupe namespace
 * @property {string}  name      display name / attribution
 * @property {string}  url       feed or API endpoint
 * @property {'rss'|'json'} adapter
 * @property {string}  board     target board slug
 * @property {'news'|'video'} kind
 * @property {boolean} nsfw      does this source carry explicit imagery?
 * @property {boolean} enabled
 * @property {boolean} verified  endpoint confirmed reachable + correctly shaped
 * @property {object} [map]      JSON adapter field mapping
 * @property {string} [itemsPath] JSON adapter path to the item array
 * @property {string[]} [filter] only file items matching one of these terms
 * @property {string} [note]
 */

/**
 * Relevance filters.
 *
 * Several of the best sources here are *general* publications that cover the
 * subject among many others. Tokyo Reporter files Japanese crime and social
 * news, of which the adult industry is a slice; Anime News Network covers the
 * whole animation business, of which adult animation is a corner.
 *
 * Filing those feeds wholesale onto a topical board fills it with items that do
 * not belong there — a road accident on the JAV desk, a shonen casting notice
 * on the adult-animation board. So a source may declare the terms an item has
 * to touch before it is filed. An honestly quiet board beats a full one that is
 * about something else.
 */
const ADULT_INDUSTRY = [
  'adult video', 'adult film', 'adult entertainment', 'adult industry', 'adult movie',
  'av actress', 'av industry', 'av star', 'av appearance', 'jav',
  'porn', 'pornograph', 'sex industry', 'sex work', 'sex worker',
  'obscenity', 'indecen', 'red-light', 'soapland', 'hostess club',
  'onlyfans', 'fansly', 'camming', 'cam site', 'strip club',
];

const ADULT_ANIMATION = [
  'hentai', 'ecchi', 'eroge', 'ero-', 'erotic', 'adult anime', 'adult animation',
  'adult game', 'adult manga', 'adult visual novel', 'r-18', 'r18', 'seijin',
  'doujin', 'nsfw', 'sexual content', 'censorship', 'age rating', 'age verification',
  'steam', 'itch.io', 'obscenity', 'nudity',
];

/** @type {Source[]} */
const BUILTIN = [
  // -- adult industry trade press ------------------------------------------
  {
    id: 'fsc', name: 'Free Speech Coalition', adapter: 'rss', kind: 'news',
    url: 'https://www.freespeechcoalition.com/blog?format=rss',
    board: 'policy', nsfw: false, enabled: true, verified: true,
  },
  {
    id: 'xbiz', name: 'XBIZ', adapter: 'rss', kind: 'news',
    url: 'https://www.xbiz.com/rss/', board: 'business', nsfw: false,
    enabled: true, verified: false, note: 'blocked by network filter on dev machine',
  },
  {
    id: 'xbiz-newswire', name: 'XBIZ Newswire', adapter: 'rss', kind: 'news',
    url: 'https://www.xbiz.com/rss/newswire/', board: 'business', nsfw: false,
    enabled: true, verified: false, note: 'blocked by network filter on dev machine',
  },
  {
    id: 'avn', name: 'AVN', adapter: 'rss', kind: 'news',
    url: 'https://avn.com/feed/articles.rss', board: 'newsroom', nsfw: false,
    enabled: true, verified: false, note: 'blocked by network filter on dev machine',
  },
  {
    id: 'ynot', name: 'YNOT', adapter: 'rss', kind: 'news',
    url: 'https://www.ynotmag.com/feed/', board: 'business', nsfw: false,
    enabled: true, verified: false, note: 'blocked by network filter on dev machine',
  },

  // -- creator economy / platform business ---------------------------------
  {
    id: 'tubefilter', name: 'Tubefilter', adapter: 'rss', kind: 'news',
    url: 'https://www.tubefilter.com/feed/', board: 'creators', nsfw: false,
    enabled: true, verified: true,
  },

  // -- policy / law --------------------------------------------------------
  {
    id: 'japantimes', name: 'The Japan Times', adapter: 'rss', kind: 'news',
    url: 'https://www.japantimes.co.jp/feed/topstories/', board: 'policy', nsfw: false,
    enabled: false, verified: true, note: 'general news — enable if you want wider Japan coverage',
  },

  // -- JAV / Japan ---------------------------------------------------------
  {
    id: 'tokyoreporter', name: 'Tokyo Reporter', adapter: 'rss', kind: 'news',
    url: 'https://www.tokyoreporter.com/feed/', board: 'jav', nsfw: false,
    enabled: true, verified: true,
    filter: ADULT_INDUSTRY,
  },
  {
    id: 'soranews', name: 'SoraNews24', adapter: 'rss', kind: 'news',
    url: 'https://soranews24.com/feed/', board: 'jav', nsfw: false,
    enabled: true, verified: true,
    filter: ADULT_INDUSTRY,
  },

  // -- hentai / anime industry ---------------------------------------------
  {
    id: 'mal-news', name: 'MyAnimeList News', adapter: 'rss', kind: 'news',
    url: 'https://myanimelist.net/rss/news.xml', board: 'hentai', nsfw: false,
    enabled: true, verified: true,
    filter: ADULT_ANIMATION,
  },
  {
    id: 'otakuusa', name: 'Otaku USA', adapter: 'rss', kind: 'news',
    url: 'https://otakuusamagazine.com/feed/', board: 'hentai', nsfw: false,
    enabled: true, verified: true,
    filter: ADULT_ANIMATION,
  },
  {
    id: 'animecorner', name: 'Anime Corner', adapter: 'rss', kind: 'news',
    url: 'https://animecorner.me/feed/', board: 'hentai', nsfw: false,
    enabled: true, verified: true,
    filter: ADULT_ANIMATION,
  },
  {
    id: 'ann', name: 'Anime News Network', adapter: 'rss', kind: 'news',
    url: 'https://www.animenewsnetwork.com/news/rss.xml', board: 'hentai', nsfw: false,
    enabled: true, verified: false, note: 'timed out on dev machine; usually fine',
    filter: ADULT_ANIMATION,
  },

  // -- trending video ------------------------------------------------------
  // These publish documented, key-free JSON endpoints. Each returns metadata
  // and a thumbnail; we store the link and the picture and send readers to the
  // publisher to watch. Nothing is mirrored or re-hosted.
  {
    id: 'eporner', name: 'EPorner', adapter: 'json', kind: 'video',
    url: 'https://www.eporner.com/api/v2/video/search/?query=&per_page=30&order=top-weekly&format=json&thumbsize=big',
    board: 'videos', nsfw: true, enabled: true, verified: false,
    note: 'documented public API v2; blocked by network filter on dev machine',
    itemsPath: 'videos',
    map: {
      guid: 'id',
      title: 'title',
      link: 'url',
      image: 'default_thumb.src',
      imageW: 'default_thumb.width',
      imageH: 'default_thumb.height',
      duration: 'length_sec',
      views: 'views',
      tags: 'keywords',
      publishedAt: 'added',
    },
  },
  {
    id: 'pornhub', name: 'Pornhub', adapter: 'json', kind: 'video',
    url: 'https://www.pornhub.com/webmasters/search?thumbsize=large&ordering=mostviewed&period=weekly&page=1',
    board: 'videos', nsfw: true, enabled: true, verified: false,
    note: 'webmasters API; blocked by network filter on dev machine',
    itemsPath: 'videos',
    map: {
      guid: 'video_id',
      title: 'title',
      link: 'url',
      image: 'default_thumb',
      duration: 'duration',
      views: 'views',
      tags: 'tags[].tag_name',
      publishedAt: 'publish_date',
    },
  },
  {
    id: 'redtube', name: 'RedTube', adapter: 'json', kind: 'video',
    url: 'https://api.redtube.com/?data=redtube.Videos.searchVideos&output=json&ordering=mostviewed&period=weekly&thumbsize=big',
    board: 'videos', nsfw: true, enabled: false, verified: false,
    note: 'same network as Pornhub — enable if you want the extra volume',
    itemsPath: 'videos',
    map: {
      guid: 'video.video_id',
      title: 'video.title',
      link: 'video.url',
      image: 'video.default_thumb',
      duration: 'video.duration',
      views: 'video.views',
      tags: 'video.tags[].tag_name',
      publishedAt: 'video.publish_date',
    },
  },
];

// ---------------------------------------------------------------------------
// Persistence — health, and operator-added sources
// ---------------------------------------------------------------------------

const upsertBuiltin = db.prepare(`
  INSERT INTO sources (id, name, url, adapter, board_slug, kind, nsfw, enabled, builtin, verified, note, created_at)
  VALUES (@id, @name, @url, @adapter, @board, @kind, @nsfw, @enabled, 1, @verified, @note, @now)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name, url = excluded.url, adapter = excluded.adapter,
    board_slug = excluded.board_slug, kind = excluded.kind, nsfw = excluded.nsfw,
    verified = excluded.verified, note = excluded.note
`);

/**
 * Write the built-in registry into the database, preserving whatever the
 * operator has toggled. `enabled` is deliberately absent from the UPDATE list:
 * a source someone switched off stays off across restarts.
 */
function syncBuiltins() {
  const now = Date.now();
  const tx = db.transaction(() => {
    for (const s of BUILTIN) {
      upsertBuiltin.run({
        id: s.id, name: s.name, url: s.url, adapter: s.adapter, board: s.board,
        kind: s.kind, nsfw: s.nsfw ? 1 : 0, enabled: s.enabled ? 1 : 0,
        verified: s.verified ? 1 : 0, note: s.note || '', now,
      });
    }
  });
  tx();
}

const BUILTIN_BY_ID = new Map(BUILTIN.map((s) => [s.id, s]));

function shape(row) {
  const builtin = BUILTIN_BY_ID.get(row.id);
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    adapter: row.adapter,
    board: row.board_slug,
    kind: row.kind,
    nsfw: !!row.nsfw,
    enabled: !!row.enabled,
    builtin: !!row.builtin,
    verified: !!row.verified,
    note: row.note || '',
    // Mapping lives in code, not the database — it is a parser detail, and
    // letting it be edited over HTTP would be a needless foothold.
    itemsPath: builtin ? builtin.itemsPath : row.items_path || '',
    map: builtin ? builtin.map : safeJson(row.field_map),
    filter: builtin ? builtin.filter || null : null,
    lastRunAt: row.last_run_at,
    lastOkAt: row.last_ok_at,
    lastStatus: row.last_status || '',
    lastError: row.last_error || '',
    itemsSeen: row.items_seen,
    itemsAdded: row.items_added,
  };
}

function safeJson(str) {
  if (!str) return null;
  try { return JSON.parse(str); } catch { return null; }
}

const all = () => db.prepare('SELECT * FROM sources ORDER BY kind, id').all().map(shape);
const enabled = () => db.prepare('SELECT * FROM sources WHERE enabled = 1 ORDER BY kind, id').all().map(shape);
const byId = (id) => {
  const row = db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
  return row ? shape(row) : null;
};

function setEnabled(id, on) {
  return db.prepare('UPDATE sources SET enabled = ? WHERE id = ?').run(on ? 1 : 0, id).changes;
}

function add({ id, name, url, adapter = 'rss', board, kind = 'news', nsfw = false, itemsPath = '', map = null, note = '' }) {
  return db.prepare(`
    INSERT INTO sources (id, name, url, adapter, board_slug, kind, nsfw, enabled, builtin, verified, note, items_path, field_map, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0, ?, ?, ?, ?)
  `).run(id, name, url, adapter, board, kind, nsfw ? 1 : 0, note, itemsPath, map ? JSON.stringify(map) : null, Date.now());
}

function remove(id) {
  return db.prepare('DELETE FROM sources WHERE id = ? AND builtin = 0').run(id).changes;
}

/** Record the outcome of a run so the operator can see what is actually working. */
const recordRun = db.prepare(`
  UPDATE sources SET last_run_at = @now, last_status = @status, last_error = @error,
                     items_seen = @seen, items_added = @added,
                     last_ok_at = CASE WHEN @status = 'ok' THEN @now ELSE last_ok_at END
   WHERE id = @id
`);

function report(id, { status, error = '', seen = 0, added = 0 }) {
  recordRun.run({ id, now: Date.now(), status, error: String(error).slice(0, 400), seen, added });
}

module.exports = {
  BUILTIN, USER_AGENT, syncBuiltins, all, enabled, byId, setEnabled, add, remove, report,
};
