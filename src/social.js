'use strict';

/**
 * The parts of a forum that are about people rather than posts: what happened
 * while you were away, private messages, awards, custom feeds and blocking.
 *
 * Kept in one module because they share a shape — all of them are small,
 * user-scoped, write-on-event tables that the feed layer never touches — and
 * because splitting five two-hundred-line concerns across five files makes them
 * harder to hold in your head, not easier.
 */

const { db } = require('./db');

const stmtCache = new Map();
function prep(sql) {
  let s = stmtCache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    stmtCache.set(sql, s);
  }
  return s;
}

const now = () => Date.now();

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

const notifications = {
  /**
   * Written at the moment the thing happens, not derived on read.
   * Self-notifications are dropped here rather than at every call site — you
   * replying to yourself is the single most common way a naive inbox fills up
   * with noise.
   */
  add({ userId, kind, actorId = null, postId = null, commentId = null, title = '', body = '' }) {
    if (!userId || userId === actorId) return null;
    return Number(prep(
      `INSERT INTO notifications (user_id, kind, actor_id, post_id, comment_id, title, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(userId, kind, actorId, postId, commentId, title.slice(0, 200), body.slice(0, 400), now()).lastInsertRowid);
  },

  list(userId, { filter = 'all', limit = 50 } = {}) {
    const where = filter === 'unread' ? 'AND n.read_at = 0'
      : filter === 'replies' ? "AND n.kind IN ('reply', 'comment_reply')"
        : filter === 'mentions' ? "AND n.kind = 'mention'"
          : '';
    return prep(
      `SELECT n.id, n.kind, n.title, n.body, n.post_id, n.comment_id, n.read_at, n.created_at,
              u.username AS actor, p.title AS post_title
         FROM notifications n
         LEFT JOIN users u ON u.id = n.actor_id
         LEFT JOIN posts p ON p.id = n.post_id
        WHERE n.user_id = ? ${where}
        ORDER BY n.created_at DESC LIMIT ?`
    ).all(userId, limit);
  },

  unreadCount(userId) {
    if (!userId) return 0;
    return prep('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at = 0').get(userId).n;
  },

  markRead(userId, ids = null) {
    if (ids && ids.length) {
      return prep(
        `UPDATE notifications SET read_at = ?
          WHERE user_id = ? AND read_at = 0 AND id IN (${ids.map(() => '?').join(',')})`
      ).run(now(), userId, ...ids).changes;
    }
    return prep('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at = 0').run(now(), userId).changes;
  },
};

// ---------------------------------------------------------------------------
// Direct messages
// ---------------------------------------------------------------------------

/** Pairs are stored ordered, so (a,b) and (b,a) resolve to one conversation. */
const pair = (a, b) => (a < b ? [a, b] : [b, a]);

const messages = {
  /** Find or open the conversation between two people. */
  conversationWith(userId, otherId) {
    const [low, high] = pair(userId, otherId);
    let row = prep('SELECT * FROM conversations WHERE low_id = ? AND high_id = ?').get(low, high);
    if (!row) {
      const ts = now();
      prep('INSERT INTO conversations (low_id, high_id, last_at, created_at) VALUES (?, ?, ?, ?)')
        .run(low, high, ts, ts);
      row = prep('SELECT * FROM conversations WHERE low_id = ? AND high_id = ?').get(low, high);
    }
    return row;
  },

  send({ fromId, toId, body }) {
    const conv = this.conversationWith(fromId, toId);
    const ts = now();
    const tx = db.transaction(() => {
      const id = prep('INSERT INTO messages (conversation_id, sender_id, body, created_at) VALUES (?, ?, ?, ?)')
        .run(conv.id, fromId, body, ts).lastInsertRowid;
      prep('UPDATE conversations SET last_at = ? WHERE id = ?').run(ts, conv.id);
      return Number(id);
    });
    return { id: tx(), conversationId: conv.id };
  },

  /** Conversation list with the other party, the last line, and unread count. */
  inbox(userId, limit = 50) {
    return prep(
      `SELECT c.id, c.last_at,
              u.username AS other, u.avatar_seed AS other_seed,
              (SELECT body FROM messages m WHERE m.conversation_id = c.id
                ORDER BY m.created_at DESC LIMIT 1) AS preview,
              (SELECT sender_id FROM messages m WHERE m.conversation_id = c.id
                ORDER BY m.created_at DESC LIMIT 1) AS last_sender,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id
                AND m.sender_id != ? AND m.read_at = 0) AS unread
         FROM conversations c
         JOIN users u ON u.id = CASE WHEN c.low_id = ? THEN c.high_id ELSE c.low_id END
        WHERE (c.low_id = ? OR c.high_id = ?) AND c.last_at > 0
        ORDER BY c.last_at DESC LIMIT ?`
    ).all(userId, userId, userId, userId, limit).filter((c) => c.preview);
  },

  thread(userId, conversationId, limit = 200) {
    const conv = prep('SELECT * FROM conversations WHERE id = ?').get(conversationId);
    if (!conv || (conv.low_id !== userId && conv.high_id !== userId)) return null;
    const otherId = conv.low_id === userId ? conv.high_id : conv.low_id;
    const other = prep('SELECT username, avatar_seed FROM users WHERE id = ?').get(otherId);

    // Opening a thread is reading it.
    prep('UPDATE messages SET read_at = ? WHERE conversation_id = ? AND sender_id != ? AND read_at = 0')
      .run(now(), conversationId, userId);

    const rows = prep(
      `SELECT m.id, m.body, m.created_at, m.sender_id, u.username AS sender
         FROM messages m JOIN users u ON u.id = m.sender_id
        WHERE m.conversation_id = ? ORDER BY m.created_at ASC LIMIT ?`
    ).all(conversationId, limit);

    return {
      id: conversationId,
      other: other?.username || '[deleted]',
      messages: rows.map((m) => ({ ...m, mine: m.sender_id === userId })),
    };
  },

  unreadCount(userId) {
    if (!userId) return 0;
    return prep(
      `SELECT COUNT(*) AS n FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE (c.low_id = ? OR c.high_id = ?) AND m.sender_id != ? AND m.read_at = 0`
    ).get(userId, userId, userId).n;
  },
};

// ---------------------------------------------------------------------------
// Awards
//
// Deliberately not a currency. Every account gets a small monthly allowance, so
// giving an award costs attention rather than money — a paid award is a way to
// buy visibility, which is precisely what a vote is supposed to measure.
// ---------------------------------------------------------------------------

const AWARDS = [
  { slug: 'receipts', label: 'Receipts', emoji: '🧾', blurb: 'Brought evidence.' },
  { slug: 'firsthand', label: 'First-hand', emoji: '🎬', blurb: 'Spoke from inside the work.' },
  { slug: 'changed-my-mind', label: 'Changed my mind', emoji: '🔄', blurb: 'Actually moved someone.' },
  { slug: 'careful', label: 'Careful', emoji: '🕯', blurb: 'Handled a hard subject well.' },
  { slug: 'saved-me', label: 'Saved me', emoji: '🛟', blurb: 'Practical help that worked.' },
];

const AWARD_MAP = new Map(AWARDS.map((a) => [a.slug, a]));
const MONTHLY_ALLOWANCE = 5;

const awards = {
  CATALOGUE: AWARDS,

  /** How many are left this calendar month. */
  remaining(userId) {
    const since = new Date();
    since.setUTCDate(1);
    since.setUTCHours(0, 0, 0, 0);
    const used = prep('SELECT COUNT(*) AS n FROM award_grants WHERE giver_id = ? AND created_at >= ?')
      .get(userId, since.getTime()).n;
    return Math.max(0, MONTHLY_ALLOWANCE - used);
  },

  give({ giverId, targetType, targetId, award, note = '' }) {
    if (!AWARD_MAP.has(award)) return { ok: false, error: 'No such award.' };
    if (this.remaining(giverId) <= 0) {
      return { ok: false, error: `You have given all ${MONTHLY_ALLOWANCE} of this month's awards.` };
    }
    const dupe = prep(
      'SELECT 1 FROM award_grants WHERE giver_id = ? AND target_type = ? AND target_id = ? AND award = ?'
    ).get(giverId, targetType, targetId, award);
    if (dupe) return { ok: false, error: 'You already gave that one here.' };

    prep(
      `INSERT INTO award_grants (giver_id, target_type, target_id, award, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(giverId, targetType, targetId, award, note.slice(0, 200), now());

    return { ok: true, counts: this.forTarget(targetType, targetId), remaining: this.remaining(giverId) };
  },

  forTarget(targetType, targetId) {
    const rows = prep(
      'SELECT award, COUNT(*) AS n FROM award_grants WHERE target_type = ? AND target_id = ? GROUP BY award'
    ).all(targetType, targetId);
    return rows.map((r) => ({ ...AWARD_MAP.get(r.award), count: r.n })).filter((a) => a.slug);
  },

  /** One query for a whole feed page. */
  forTargets(targetType, ids) {
    if (!ids.length) return {};
    const rows = prep(
      `SELECT target_id, award, COUNT(*) AS n FROM award_grants
        WHERE target_type = ? AND target_id IN (${ids.map(() => '?').join(',')})
        GROUP BY target_id, award`
    ).all(targetType, ...ids);
    const out = {};
    for (const r of rows) {
      const meta = AWARD_MAP.get(r.award);
      if (meta) (out[r.target_id] ||= []).push({ ...meta, count: r.n });
    }
    return out;
  },

  receivedBy(userId) {
    return prep(
      `SELECT COUNT(*) AS n FROM award_grants g
        WHERE (g.target_type = 'post' AND g.target_id IN (SELECT id FROM posts WHERE author_id = ?))
           OR (g.target_type = 'comment' AND g.target_id IN (SELECT id FROM comments WHERE author_id = ?))`
    ).get(userId, userId).n;
  },
};

// ---------------------------------------------------------------------------
// Custom feeds
// ---------------------------------------------------------------------------

const customFeeds = {
  list(userId) {
    const feeds = prep('SELECT id, slug, name, created_at FROM custom_feeds WHERE user_id = ? ORDER BY name').all(userId);
    for (const feed of feeds) {
      feed.boards = prep(
        `SELECT b.slug, b.name, b.accent FROM custom_feed_boards f
           JOIN boards b ON b.id = f.board_id WHERE f.feed_id = ? ORDER BY b.name`
      ).all(feed.id);
    }
    return feeds;
  },

  bySlug(userId, slug) {
    const feed = prep('SELECT id, slug, name FROM custom_feeds WHERE user_id = ? AND slug = ?').get(userId, slug);
    if (!feed) return null;
    feed.boardIds = prep('SELECT board_id FROM custom_feed_boards WHERE feed_id = ?')
      .all(feed.id).map((r) => r.board_id);
    feed.boards = prep(
      `SELECT b.slug, b.name, b.accent FROM custom_feed_boards f
         JOIN boards b ON b.id = f.board_id WHERE f.feed_id = ? ORDER BY b.name`
    ).all(feed.id);
    return feed;
  },

  create(userId, { slug, name, boardIds = [] }) {
    const ts = now();
    const tx = db.transaction(() => {
      const id = Number(prep('INSERT INTO custom_feeds (user_id, slug, name, created_at) VALUES (?, ?, ?, ?)')
        .run(userId, slug, name, ts).lastInsertRowid);
      const link = prep('INSERT OR IGNORE INTO custom_feed_boards (feed_id, board_id) VALUES (?, ?)');
      for (const boardId of boardIds) link.run(id, boardId);
      return id;
    });
    return tx();
  },

  setBoards(userId, slug, boardIds) {
    const feed = prep('SELECT id FROM custom_feeds WHERE user_id = ? AND slug = ?').get(userId, slug);
    if (!feed) return 0;
    const tx = db.transaction(() => {
      prep('DELETE FROM custom_feed_boards WHERE feed_id = ?').run(feed.id);
      const link = prep('INSERT OR IGNORE INTO custom_feed_boards (feed_id, board_id) VALUES (?, ?)');
      for (const boardId of boardIds) link.run(feed.id, boardId);
    });
    tx();
    return boardIds.length;
  },

  remove(userId, slug) {
    return prep('DELETE FROM custom_feeds WHERE user_id = ? AND slug = ?').run(userId, slug).changes;
  },
};

// ---------------------------------------------------------------------------
// Blocking
//
// One-directional: it hides the blocked party from the blocker, and not the
// reverse. A block should never be a way to make yourself unreadable to
// somebody who is documenting your behaviour.
// ---------------------------------------------------------------------------

const blocks = {
  add(userId, blockedId) {
    if (userId === blockedId) return 0;
    return prep('INSERT OR IGNORE INTO blocks (user_id, blocked_id, created_at) VALUES (?, ?, ?)')
      .run(userId, blockedId, now()).changes;
  },

  remove(userId, blockedId) {
    return prep('DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?').run(userId, blockedId).changes;
  },

  idsFor(userId) {
    if (!userId) return [];
    return prep('SELECT blocked_id FROM blocks WHERE user_id = ?').all(userId).map((r) => r.blocked_id);
  },

  list(userId) {
    return prep(
      `SELECT u.username, b.created_at FROM blocks b JOIN users u ON u.id = b.blocked_id
        WHERE b.user_id = ? ORDER BY b.created_at DESC`
    ).all(userId);
  },

  has(userId, otherId) {
    if (!userId || !otherId) return false;
    return !!prep('SELECT 1 FROM blocks WHERE user_id = ? AND blocked_id = ?').get(userId, otherId);
  },
};

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

const DEFAULT_PREFS = {
  theme: '',           // '' = follow the device/toggle
  view: 'card',
  revealNsfw: true,   // the age gate is the gate; see ui.js revealsAll()
  autoplay: false,
  hideNsfwBoards: false,
  emailDigest: false,
};

const ALLOWED_PREFS = new Set(Object.keys(DEFAULT_PREFS));

const prefs = {
  DEFAULTS: DEFAULT_PREFS,

  get(userId) {
    const row = prep('SELECT prefs FROM users WHERE id = ?').get(userId);
    let stored = {};
    try { stored = JSON.parse(row?.prefs || '{}'); } catch { stored = {}; }
    return { ...DEFAULT_PREFS, ...stored };
  },

  set(userId, patch) {
    const next = { ...this.get(userId) };
    for (const [key, value] of Object.entries(patch || {})) {
      if (!ALLOWED_PREFS.has(key)) continue;
      next[key] = typeof DEFAULT_PREFS[key] === 'boolean' ? !!value : String(value).slice(0, 40);
    }
    prep('UPDATE users SET prefs = ? WHERE id = ?').run(JSON.stringify(next), userId);
    return next;
  },
};

module.exports = { notifications, messages, awards, customFeeds, blocks, prefs, AWARDS };
