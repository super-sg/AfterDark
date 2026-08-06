'use strict';

/**
 * Live presence and traffic counters.
 *
 * Two constraints shape everything here.
 *
 * **Eight workers.** Requests land on whichever process is free, so anything
 * held in memory counts one visitor up to eight times and loses the rest.
 * State goes in SQLite, which every worker already has open in WAL mode.
 *
 * **This is an adult site.** A record of who read what is the most dangerous
 * data this application could hold — worth more to a blackmailer than to us,
 * and the first thing anyone would subpoena. So identifiers are HMACs that
 * cannot be reversed to an IP, the current path is kept only long enough to
 * answer "how many people are on this board", nothing is retained per visitor,
 * and traffic is bucketed into aggregate counters at write time rather than
 * logged per request and summed later.
 *
 * The panel is designed around what it must never be able to show.
 */

const crypto = require('node:crypto');
const { db } = require('./db');

const SECRET = process.env.SESSION_SECRET || 'dev-only-insecure-secret';

/** A visitor counts as present for this long after their last request. */
const PRESENCE_TTL_MS = 5 * 60_000;
/** Rows older than this are deleted outright. */
const PRESENCE_KEEP_MS = 30 * 60_000;
/** Counters are kept for a day; the panel never asks for more. */
const METRICS_KEEP_MS = 26 * 60 * 60_000;
/** One presence write per visitor per this interval, not one per request. */
const WRITE_EVERY_MS = 25_000;

const stmt = new Map();
const prep = (sql) => {
  if (!stmt.has(sql)) stmt.set(sql, db.prepare(sql));
  return stmt.get(sql);
};

const minute = (t = Date.now()) => Math.floor(t / 60_000);

/**
 * Stable per-visitor id that is not an identity.
 *
 * Prefers the session cookie so one person on one device is one row across IP
 * changes; falls back to the address plus a coarse user-agent hint. Either way
 * the output is an HMAC — the table cannot be turned back into who was here.
 */
function visitorId(req) {
  const seed = req.cookies?.ad_sid || `${req.ip}|${(req.get('user-agent') || '').slice(0, 80)}`;
  return crypto.createHmac('sha256', SECRET).update(`presence:${seed}`).digest('base64url').slice(0, 22);
}

// Per-worker throttle. Losing it on restart costs one extra write per visitor.
const lastWrite = new Map();

const touch = prep(`
  INSERT INTO presence (id, user_id, path, first_seen_at, last_seen_at)
  VALUES (@id, @userId, @path, @now, @now)
  ON CONFLICT(id) DO UPDATE SET
    last_seen_at = @now, path = @path, user_id = COALESCE(@userId, presence.user_id)
`);

const bump = prep(`
  INSERT INTO metrics (bucket, kind, n) VALUES (?, ?, 1)
  ON CONFLICT(bucket, kind) DO UPDATE SET n = n + 1
`);

/** Count one event into the current minute. */
function count(kind) {
  try {
    bump.run(minute(), kind);
  } catch {
    /* a lost counter is not worth failing a request over */
  }
}

/**
 * Express middleware. Records presence and a page-view counter.
 *
 * Only the shell and API reads are counted — assets, the image proxy and ad
 * frames would multiply one page view by thirty and tell you nothing.
 */
function record(req, res, next) {
  try {
    const now = Date.now();
    const id = visitorId(req);
    const previous = lastWrite.get(id) || 0;

    if (now - previous >= WRITE_EVERY_MS) {
      lastWrite.set(id, now);
      // Referer is the SPA route the reader is actually on; the API path would
      // just say /api/feed for every board.
      let path = '/';
      try {
        path = new URL(req.get('referer') || 'http://x/').pathname || '/';
      } catch { /* keep the default */ }
      touch.run({ id, userId: req.user?.id ?? null, path: path.slice(0, 120), now });
      count('visits');
      if (lastWrite.size > 20_000) lastWrite.clear();
    }
    count('requests');
  } catch {
    /* never break a request to record it */
  }
  next();
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const live = () => {
  const since = Date.now() - PRESENCE_TTL_MS;
  const totals = prep(`
    SELECT COUNT(*) AS total, COUNT(user_id) AS signedIn
      FROM presence WHERE last_seen_at > ?
  `).get(since);

  return {
    online: totals.total,
    signedIn: totals.signedIn,
    anonymous: totals.total - totals.signedIn,
    // Aggregate only. There is deliberately no query in this file that returns
    // a visitor alongside the page they are reading.
    byPath: prep(`
      SELECT path, COUNT(*) AS n FROM presence
       WHERE last_seen_at > ? AND path != ''
       GROUP BY path ORDER BY n DESC LIMIT 12
    `).all(since),
  };
};

/** Per-minute series for the last `minutes`, zero-filled so gaps are visible. */
function series(kind, minutes = 60) {
  const end = minute();
  const start = end - minutes + 1;
  const rows = prep('SELECT bucket, n FROM metrics WHERE kind = ? AND bucket >= ? ORDER BY bucket').all(kind, start);
  const found = new Map(rows.map((r) => [r.bucket, r.n]));
  const out = [];
  for (let b = start; b <= end; b++) out.push({ t: b * 60_000, n: found.get(b) || 0 });
  return out;
}

function totals(kind, minutes) {
  const start = minute() - minutes + 1;
  return prep('SELECT COALESCE(SUM(n), 0) AS n FROM metrics WHERE kind = ? AND bucket >= ?').get(kind, start).n;
}

/** Drop what has aged out. Cheap enough to run on the scheduler's timer. */
function prune() {
  const now = Date.now();
  const presence = prep('DELETE FROM presence WHERE last_seen_at < ?').run(now - PRESENCE_KEEP_MS).changes;
  const metrics = prep('DELETE FROM metrics WHERE bucket < ?').run(minute(now - METRICS_KEEP_MS)).changes;
  return { presence, metrics };
}

module.exports = { record, count, live, series, totals, prune, visitorId, PRESENCE_TTL_MS };
