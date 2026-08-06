'use strict';

/**
 * Query layer. Everything the routes need to touch the database lives here so
 * the HTTP layer stays thin and every statement is prepared exactly once.
 *
 * Feeds use keyset (cursor) pagination rather than LIMIT/OFFSET: page 500 costs
 * the same as page 1, which is the difference between a front page that stays
 * fast under load and one that degrades as the archive grows.
 */

const { db } = require('./db');
const { hotRank, confidence, risingScore } = require('./ranking');

// Memoised statement preparation — better-sqlite3 statements are reusable and
// cheap to keep around, but expensive to re-prepare per request.
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
// Cursors
// ---------------------------------------------------------------------------

function encodeCursor(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function decodeCursor(str) {
  if (!str) return null;
  try {
    const obj = JSON.parse(Buffer.from(String(str), 'base64url').toString('utf8'));
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

const users = {
  create(username, passwordHash, role = 'user') {
    const info = prep(
      `INSERT INTO users (username, password_hash, role, avatar_seed, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(username, passwordHash, role, Math.random().toString(36).slice(2, 10), now(), now());
    return info.lastInsertRowid;
  },

  byUsername(username) {
    return prep('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
  },

  byId(id) {
    return prep('SELECT * FROM users WHERE id = ?').get(id);
  },

  publicProfile(username) {
    const u = prep(
      `SELECT id, username, role, bio, avatar_seed, post_karma, comment_karma, created_at, banned_until
         FROM users WHERE username = ? COLLATE NOCASE`
    ).get(username);
    if (!u) return null;
    const counts = prep(
      `SELECT (SELECT COUNT(*) FROM posts WHERE author_id = ? AND removed = 0)    AS posts,
              (SELECT COUNT(*) FROM comments WHERE author_id = ? AND removed = 0) AS comments`
    ).get(u.id, u.id);
    return {
      id: u.id,
      username: u.username,
      role: u.role,
      bio: u.bio,
      avatarSeed: u.avatar_seed,
      postKarma: u.post_karma,
      commentKarma: u.comment_karma,
      createdAt: u.created_at,
      suspended: u.banned_until > now(),
      postCount: counts.posts,
      commentCount: counts.comments,
    };
  },

  updateBio(id, bio) {
    prep('UPDATE users SET bio = ? WHERE id = ?').run(bio, id);
  },

  markAgeVerified(id, method) {
    prep('UPDATE users SET age_ok_at = ?, age_method = ? WHERE id = ?').run(now(), method, id);
  },

  ban(id, untilMs, reason) {
    prep('UPDATE users SET banned_until = ?, ban_reason = ? WHERE id = ?').run(untilMs, reason, id);
  },

  setPassword(id, hash) {
    prep('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
  },

  setRole(id, role) {
    prep('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  },

  count() {
    return prep('SELECT COUNT(*) AS n FROM users').get().n;
  },

  activeSince(sinceMs) {
    return prep('SELECT COUNT(*) AS n FROM users WHERE last_seen_at > ?').get(sinceMs).n;
  },
};

// ---------------------------------------------------------------------------
// Boards
// ---------------------------------------------------------------------------

const boards = {
  all() {
    return prep(
      `SELECT id, slug, name, tagline, description, kind, accent, icon, rules, nsfw, official, firehose,
              member_count, post_count, created_at
         FROM boards ORDER BY sort_order ASC, member_count DESC`
    ).all();
  },

  bySlug(slug) {
    return prep('SELECT * FROM boards WHERE slug = ? COLLATE NOCASE').get(slug);
  },

  byId(id) {
    return prep('SELECT * FROM boards WHERE id = ?').get(id);
  },

  create({ slug, name, tagline = '', description = '', kind = 'discussion', accent = '#e0245e', icon = '#', rules = [], sortOrder = 100, nsfw = false }) {
    return prep(
      `INSERT INTO boards (slug, name, tagline, description, kind, accent, icon, rules, nsfw, created_at, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(slug, name, tagline, description, kind, accent, icon, JSON.stringify(rules), nsfw ? 1 : 0, now(), sortOrder).lastInsertRowid;
  },

  /** Keep an existing board's copy in step with the seed definition. */
  update(slug, { name, tagline, description, kind, accent, rules, sortOrder, nsfw, firehose = false }) {
    return prep(
      `UPDATE boards SET name = ?, tagline = ?, description = ?, kind = ?, accent = ?,
                         rules = ?, sort_order = ?, nsfw = ?, firehose = ?
        WHERE slug = ? COLLATE NOCASE`
    ).run(name, tagline, description, kind, accent, JSON.stringify(rules || []), sortOrder, nsfw ? 1 : 0, firehose ? 1 : 0, slug).changes;
  },

  subscribe(userId, boardId) {
    const existing = prep('SELECT 1 FROM board_subs WHERE user_id = ? AND board_id = ?').get(userId, boardId);
    const tx = db.transaction(() => {
      if (existing) {
        prep('DELETE FROM board_subs WHERE user_id = ? AND board_id = ?').run(userId, boardId);
        prep('UPDATE boards SET member_count = MAX(member_count - 1, 0) WHERE id = ?').run(boardId);
        return false;
      }
      prep('INSERT INTO board_subs (user_id, board_id, created_at) VALUES (?, ?, ?)').run(userId, boardId, now());
      prep('UPDATE boards SET member_count = member_count + 1 WHERE id = ?').run(boardId);
      return true;
    });
    return tx();
  },

  /**
   * Create a community owned by a user.
   *
   * Slug rules are deliberately tight: lowercase, 3–24 characters, no leading
   * or trailing punctuation. A community name is a permanent URL and a thing
   * people type, and letting the first mover take `a` or `_____` is a mess that
   * cannot be undone later.
   */
  createCommunity({ slug, name, tagline = '', description = '', accent = '#d4ff3d', ownerId, nsfw = false, rules = [] }) {
    const ts = now();
    const tx = db.transaction(() => {
      const boardId = Number(prep(
        `INSERT INTO boards (slug, name, tagline, description, kind, accent, icon, rules,
                             nsfw, created_by, official, created_at, sort_order)
         VALUES (?, ?, ?, ?, 'discussion', ?, '#', '[]', ?, ?, 0, ?, 500)`
      ).run(slug, name, tagline, description, accent, nsfw ? 1 : 0, ownerId, ts).lastInsertRowid);

      prep('INSERT INTO board_mods (board_id, user_id, role, added_by, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(boardId, ownerId, 'owner', ownerId, ts);
      // The founder is the first member; a community with zero members reads
      // as abandoned before it has had a chance to exist.
      prep('INSERT INTO board_subs (user_id, board_id, created_at) VALUES (?, ?, ?)').run(ownerId, boardId, ts);
      prep('UPDATE boards SET member_count = 1 WHERE id = ?').run(boardId);

      rules.forEach((rule, i) => {
        prep('INSERT INTO board_rules (board_id, position, title, detail, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(boardId, i + 1, rule.title, rule.detail || '', ts);
      });
      return boardId;
    });
    return tx();
  },

  updateCommunity(boardId, { name, tagline, description, accent, nsfw }) {
    return prep(
      `UPDATE boards SET name = ?, tagline = ?, description = ?, accent = ?, nsfw = ?
        WHERE id = ? AND official = 0`
    ).run(name, tagline, description, accent, nsfw ? 1 : 0, boardId).changes;
  },

  slugTaken(slug) {
    return !!prep('SELECT 1 FROM boards WHERE slug = ? COLLATE NOCASE').get(slug);
  },

  /** Newest communities people actually joined — the discovery page's spine. */
  discover({ sort = 'active', limit = 40 } = {}) {
    const order = sort === 'new' ? 'b.created_at DESC'
      : sort === 'members' ? 'b.member_count DESC, b.post_count DESC'
        : 'recent_posts DESC, b.member_count DESC';
    return prep(
      `SELECT b.id, b.slug, b.name, b.tagline, b.accent, b.kind, b.nsfw, b.official,
              b.member_count, b.post_count, b.created_at,
              u.username AS owner,
              (SELECT COUNT(*) FROM posts p
                WHERE p.board_id = b.id AND p.removed = 0 AND p.created_at > ?) AS recent_posts
         FROM boards b LEFT JOIN users u ON u.id = b.created_by
        ORDER BY ${order} LIMIT ?`
    ).all(now() - 7 * 86400e3, limit);
  },

  subscriptionsFor(userId) {
    return prep(
      `SELECT b.id, b.slug, b.name, b.accent, b.icon, b.kind
         FROM board_subs s JOIN boards b ON b.id = s.board_id
        WHERE s.user_id = ? ORDER BY b.name`
    ).all(userId);
  },

  subscribedIds(userId) {
    return prep('SELECT board_id FROM board_subs WHERE user_id = ?').all(userId).map((r) => r.board_id);
  },
};

// ---------------------------------------------------------------------------
// Community moderators
// ---------------------------------------------------------------------------

const boardMods = {
  list(boardId) {
    return prep(
      `SELECT m.role, m.created_at, u.username, u.avatar_seed
         FROM board_mods m JOIN users u ON u.id = m.user_id
        WHERE m.board_id = ? ORDER BY (m.role = 'owner') DESC, m.created_at ASC`
    ).all(boardId);
  },

  roleOf(boardId, userId) {
    if (!userId) return null;
    return prep('SELECT role FROM board_mods WHERE board_id = ? AND user_id = ?').get(boardId, userId)?.role || null;
  },

  add(boardId, userId, actorId) {
    return prep(
      `INSERT OR IGNORE INTO board_mods (board_id, user_id, role, added_by, created_at)
       VALUES (?, ?, 'mod', ?, ?)`
    ).run(boardId, userId, actorId, now()).changes;
  },

  /** An owner cannot be removed — that seat only moves by transfer. */
  remove(boardId, userId) {
    return prep("DELETE FROM board_mods WHERE board_id = ? AND user_id = ? AND role != 'owner'")
      .run(boardId, userId).changes;
  },

  boardsFor(userId) {
    return prep(
      `SELECT b.slug, b.name, b.accent, m.role FROM board_mods m
         JOIN boards b ON b.id = m.board_id
        WHERE m.user_id = ? ORDER BY b.name`
    ).all(userId);
  },
};

// ---------------------------------------------------------------------------
// Rules
//
// A rule is a row with a citation counter, not a line of prose. Every removal
// names the rule it enforced, the count is public, and the result is that a
// community can see which of its rules are load-bearing, which are decorative,
// and whether a moderator is leaning on one far harder than the others.
// ---------------------------------------------------------------------------

const boardRules = {
  list(boardId, { includeRetired = false } = {}) {
    return prep(
      `SELECT id, position, title, detail, cited_count, created_at, retired_at
         FROM board_rules
        WHERE board_id = ? ${includeRetired ? '' : 'AND retired_at = 0'}
        ORDER BY position ASC, id ASC`
    ).all(boardId);
  },

  get(ruleId) {
    return prep('SELECT * FROM board_rules WHERE id = ?').get(ruleId) || null;
  },

  add(boardId, { title, detail = '' }) {
    const next = prep('SELECT COALESCE(MAX(position), 0) + 1 AS n FROM board_rules WHERE board_id = ?').get(boardId).n;
    return Number(prep(
      'INSERT INTO board_rules (board_id, position, title, detail, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(boardId, next, title, detail, now()).lastInsertRowid);
  },

  edit(ruleId, { title, detail }) {
    return prep('UPDATE board_rules SET title = ?, detail = ? WHERE id = ?').run(title, detail, ruleId).changes;
  },

  /**
   * Rules retire rather than delete. Past removals cite them, and a moderation
   * record that points at a rule which no longer exists is worse than useless.
   */
  retire(ruleId) {
    return prep('UPDATE board_rules SET retired_at = ? WHERE id = ? AND retired_at = 0').run(now(), ruleId).changes;
  },

  cite(ruleId) {
    return prep('UPDATE board_rules SET cited_count = cited_count + 1 WHERE id = ?').run(ruleId).changes;
  },

  /** Recent enforcements of one rule, for the public record. */
  enforcementLog(ruleId, limit = 20) {
    return prep(
      `SELECT m.action, m.target_type, m.target_id, m.reason, m.created_at, u.username AS actor
         FROM mod_actions m LEFT JOIN users u ON u.id = m.actor_id
        WHERE m.rule_id = ? ORDER BY m.created_at DESC LIMIT ?`
    ).all(ruleId, limit);
  },
};

// ---------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------

const POST_COLUMNS = `
  p.id, p.board_id, p.kind, p.title, p.url, p.flair, p.source_name, p.source_url, p.published_at,
  p.ups, p.downs, p.score, p.comment_count, p.created_at, p.edited_at,
  p.locked, p.pinned, p.removed,
  p.image_url, p.image_alt, p.image_w, p.image_h, p.image_tint, p.video_kind, p.video_id,
  p.nsfw, p.duration, p.views, p.source_id, p.reaction_count,
  SUBSTR(p.body, 1, 320) AS excerpt,
  LENGTH(p.body) AS body_length,
  b.slug AS board_slug, b.name AS board_name, b.accent AS board_accent, b.icon AS board_icon,
  b.kind AS board_kind, b.nsfw AS board_nsfw,
  u.username AS author, u.role AS author_role, u.avatar_seed AS author_seed
`;

const FROM_POSTS = `
  FROM posts p
  JOIN boards b ON b.id = p.board_id
  LEFT JOIN users u ON u.id = p.author_id
`;

const TIME_WINDOWS = {
  hour: 3600e3,
  day: 86400e3,
  week: 604800e3,
  month: 2592000e3,
  year: 31536000e3,
  all: 0,
};

/**
 * Cursor-paginated feed.
 * @param {object} opts
 * @param {'hot'|'new'|'top'|'rising'} opts.sort
 * @param {number|null} opts.boardId  restrict to one board
 * @param {number[]|null} opts.boardIds restrict to a set (subscriptions)
 * @param {string} opts.window        top/rising time window key
 * @param {string|null} opts.cursor
 * @param {number} opts.limit
 */
/**
 * Cursor-paginated feed.
 *
 * `excludeFirehose` keeps high-volume shelves out of the shared feeds. A
 * board pulling 150 clips a day will bury a 400-point discussion thread purely
 * on recency, and a front page where the slowest, most-replied-to content is
 * invisible is not a front page — it is a firehose with a comment box.
 */
function feed({ sort = 'hot', boardId = null, boardIds = null, window = 'all', cursor = null, limit = 25, includeRemoved = false, excludeFirehose = false } = {}) {
  limit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const cur = decodeCursor(cursor);
  const where = [];
  const params = [];

  if (!includeRemoved) where.push('p.removed = 0');
  // Only when no specific board was asked for: visiting the shelf directly
  // should obviously still show it.
  if (excludeFirehose && !boardId) {
    where.push('b.firehose = 0');
    // Not just the shelf: a clip is a clip wherever it was filed, and 30 of
    // them arriving at once will bury a discussion thread on recency alone.
    where.push("p.kind != 'video'");
  }
  if (boardId) {
    where.push('p.board_id = ?');
    params.push(boardId);
  } else if (boardIds && boardIds.length) {
    where.push(`p.board_id IN (${boardIds.map(() => '?').join(',')})`);
    params.push(...boardIds);
  }

  const windowMs = TIME_WINDOWS[window] ?? 0;
  if (windowMs && (sort === 'top' || sort === 'rising')) {
    where.push('p.created_at > ?');
    params.push(now() - windowMs);
  }

  let orderBy;
  if (sort === 'new') {
    orderBy = 'p.created_at DESC, p.id DESC';
    if (cur) {
      where.push('(p.created_at < ? OR (p.created_at = ? AND p.id < ?))');
      params.push(cur.k, cur.k, cur.id);
    }
  } else if (sort === 'published') {
    // Newsroom ordering: the publisher's timestamp, not our ingestion time.
    orderBy = 'p.published_at DESC, p.id DESC';
    if (cur) {
      where.push('(p.published_at < ? OR (p.published_at = ? AND p.id < ?))');
      params.push(cur.k, cur.k, cur.id);
    }
  } else if (sort === 'top') {
    orderBy = 'p.score DESC, p.id DESC';
    if (cur) {
      where.push('(p.score < ? OR (p.score = ? AND p.id < ?))');
      params.push(cur.k, cur.k, cur.id);
    }
  } else if (sort === 'views') {
    // The video boards rank by what the publisher says is being watched, since
    // our own vote counts say nothing about a clip nobody here has seen yet.
    orderBy = 'p.views DESC, p.id DESC';
    if (cur) {
      where.push('(p.views < ? OR (p.views = ? AND p.id < ?))');
      params.push(cur.k, cur.k, cur.id);
    }
  } else if (sort === 'rising') {
    // Rising is a small, recomputed window — no deep pagination.
    const recent = prep(
      `SELECT ${POST_COLUMNS} ${FROM_POSTS}
        WHERE p.removed = 0 AND p.created_at > ? ${boardId ? 'AND p.board_id = ?' : ''}
          ${excludeFirehose && !boardId ? "AND b.firehose = 0 AND p.kind != 'video'" : ''}
        ORDER BY p.created_at DESC LIMIT 300`
    ).all(...(boardId ? [now() - 43200e3, boardId] : [now() - 43200e3]));
    const ranked = recent
      .map((r) => ({ ...r, _rise: risingScore(r.score, r.created_at) }))
      .sort((a, b) => b._rise - a._rise)
      .slice(0, limit);
    return { items: ranked.map(shapePost), nextCursor: null };
  } else {
    orderBy = 'p.hot DESC, p.id DESC';
    if (cur) {
      where.push('(p.hot < ? OR (p.hot = ? AND p.id < ?))');
      params.push(cur.k, cur.k, cur.id);
    }
  }

  const sql = `SELECT ${POST_COLUMNS} ${FROM_POSTS}
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY ${orderBy} LIMIT ?`;
  const rows = prep(sql).all(...params, limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const keyFor = (r) =>
    sort === 'new' ? r.created_at
      : sort === 'published' ? r.published_at
        : sort === 'top' ? r.score
          : sort === 'views' ? r.views
            : r.hot;

  return {
    items: page.map(shapePost),
    nextCursor: hasMore && last ? encodeCursor({ k: keyFor(last), id: last.id }) : null,
  };
}

/** Rough reading time — shown on long articles, where it lifts click-through. */
const readingMinutes = (chars) => Math.max(1, Math.round((chars || 0) / 5 / 230));

function shapePost(r) {
  return {
    id: r.id,
    boardId: r.board_id,
    kind: r.kind,
    title: r.title,
    excerpt: r.excerpt || '',
    truncated: (r.body_length || 0) > 320,
    readingMinutes: readingMinutes(r.body_length),
    image: r.image_url || '',
    imageAlt: r.image_alt || '',
    imageW: r.image_w || 0,
    imageH: r.image_h || 0,
    tint: r.image_tint && r.image_tint !== '-' ? r.image_tint : '',
    // 'none' is the enrichment sentinel for "we looked and found nothing".
    videoKind: r.video_kind && r.video_kind !== 'none' ? r.video_kind : '',
    videoId: r.video_id || '',
    nsfw: !!r.nsfw,
    duration: r.duration || 0,
    views: r.views || 0,
    sourceId: r.source_id || '',
    reactionCount: r.reaction_count || 0,
    url: r.url || '',
    flair: r.flair || '',
    source: r.source_name || '',
    sourceUrl: r.source_url || '',
    publishedAt: r.published_at || r.created_at,
    score: r.score,
    ups: r.ups,
    downs: r.downs,
    commentCount: r.comment_count,
    createdAt: r.created_at,
    editedAt: r.edited_at,
    locked: !!r.locked,
    pinned: !!r.pinned,
    removed: !!r.removed,
    board: {
      slug: r.board_slug, name: r.board_name, accent: r.board_accent,
      icon: r.board_icon, kind: r.board_kind, nsfw: !!r.board_nsfw,
    },
    author: r.author || '[deleted]',
    authorRole: r.author_role || 'user',
    authorSeed: r.author_seed || '',
  };
}

const posts = {
  feed,

  get(id) {
    const r = prep(
      `SELECT p.*, b.slug AS board_slug, b.name AS board_name, b.accent AS board_accent,
              b.icon AS board_icon, b.kind AS board_kind, b.rules AS board_rules,
              u.username AS author, u.role AS author_role, u.avatar_seed AS author_seed
       ${FROM_POSTS} WHERE p.id = ?`
    ).get(id);
    if (!r) return null;
    return {
      ...shapePost({ ...r, excerpt: r.body, body_length: (r.body || '').length }),
      body: r.removed ? '' : r.body,
      truncated: false,
      boardRules: safeJson(r.board_rules, []),
      removedReason: r.removed_reason || '',
    };
  },

  pinnedFor(boardId) {
    return prep(
      `SELECT ${POST_COLUMNS} ${FROM_POSTS} WHERE p.board_id = ? AND p.pinned = 1 AND p.removed = 0
        ORDER BY p.created_at DESC LIMIT 3`
    ).all(boardId).map(shapePost);
  },

  create({
    boardId, authorId, kind, title, body = '', url = '', flair = '',
    sourceName = '', sourceUrl = '', sourceId = '', wireGuid = null, publishedAt = 0,
    imageUrl = '', imageAlt = '', imageW = 0, imageH = 0, imageTint = '',
    videoKind = '', videoId = '', nsfw = false, duration = 0, views = 0,
  }) {
    const ts = now();
    const tx = db.transaction(() => {
      const info = prep(
        `INSERT INTO posts (board_id, author_id, kind, title, body, url, flair,
                            source_name, source_url, source_id, wire_guid, published_at,
                            image_url, image_alt, image_w, image_h, image_tint,
                            video_kind, video_id, nsfw, duration, views,
                            ups, score, hot, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`
      ).run(
        boardId, authorId, kind, title, body, url, flair,
        sourceName, sourceUrl, sourceId, wireGuid, publishedAt || ts,
        imageUrl, imageAlt, imageW, imageH, imageTint, videoKind, videoId,
        nsfw ? 1 : 0, duration || 0, views || 0,
        hotRank(1, ts), ts
      );
      const postId = Number(info.lastInsertRowid);
      // The author's own upvote, so the post starts at 1 like Reddit.
      //
      // OR REPLACE rather than a plain INSERT: votes point at posts
      // polymorphically (target_type, target_id) so SQLite cannot cascade them,
      // and a hard-deleted post leaves its votes behind. SQLite then reuses the
      // freed rowid for the next post, and the new author collides with a
      // stranger's vote on a post that no longer exists. The trigger below
      // stops new orphans; this keeps an old one from breaking a write.
      if (authorId) {
        prep('INSERT OR REPLACE INTO votes (user_id, target_type, target_id, value, created_at) VALUES (?, ?, ?, 1, ?)')
          .run(authorId, 'post', postId, ts);
        prep('UPDATE users SET post_karma = post_karma + 1 WHERE id = ?').run(authorId);
      }
      prep('UPDATE boards SET post_count = post_count + 1 WHERE id = ?').run(boardId);
      return postId;
    });
    return tx();
  },

  edit(id, body) {
    prep('UPDATE posts SET body = ?, edited_at = ? WHERE id = ?').run(body, now(), id);
  },

  setRemoved(id, removed, actorId, reason = '') {
    prep('UPDATE posts SET removed = ?, removed_by = ?, removed_reason = ? WHERE id = ?')
      .run(removed ? 1 : 0, actorId, reason, id);
  },

  setLocked(id, locked) {
    prep('UPDATE posts SET locked = ? WHERE id = ?').run(locked ? 1 : 0, id);
  },

  setPinned(id, pinned) {
    prep('UPDATE posts SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id);
  },

  byAuthor(username, limit = 25, cursor = null) {
    const cur = decodeCursor(cursor);
    const rows = prep(
      `SELECT ${POST_COLUMNS} ${FROM_POSTS}
        WHERE u.username = ? COLLATE NOCASE AND p.removed = 0 ${cur ? 'AND p.id < ?' : ''}
        ORDER BY p.created_at DESC, p.id DESC LIMIT ?`
    ).all(...(cur ? [username, cur.id, limit + 1] : [username, limit + 1]));
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: page.map(shapePost),
      nextCursor: hasMore ? encodeCursor({ id: page[page.length - 1].id }) : null,
    };
  },

  search(query, limit = 25) {
    const q = String(query || '').trim();
    if (!q) return [];
    // Quote each term so user input can't inject FTS5 operators.
    const match = q
      .split(/\s+/)
      .slice(0, 8)
      .map((t) => `"${t.replace(/"/g, '')}"`)
      .join(' ');
    try {
      return prep(
        `SELECT ${POST_COLUMNS}, bm25(posts_fts) AS rank
         ${FROM_POSTS}
         JOIN posts_fts f ON f.rowid = p.id
         WHERE posts_fts MATCH ? AND p.removed = 0
         ORDER BY rank LIMIT ?`
      ).all(match, limit).map(shapePost);
    } catch {
      return [];
    }
  },

  countSince(sinceMs) {
    return prep('SELECT COUNT(*) AS n FROM posts WHERE created_at > ? AND removed = 0').get(sinceMs).n;
  },

  wireExists(guid) {
    return !!prep('SELECT 1 FROM posts WHERE wire_guid = ?').get(guid);
  },

  /**
   * Has this article already been filed, under any guid?
   *
   * The guid is namespaced by source id, so renaming a source — or a publisher
   * changing its own id scheme — silently orphans every previous key and the
   * whole back catalogue re-ingests as new. The canonical URL does not move,
   * so it is the durable identity for "this is the same story".
   */
  urlExists(url) {
    if (!url) return false;
    return !!prep('SELECT 1 FROM posts WHERE url = ? OR source_url = ?').get(url, url);
  },

  /** Attach media after the fact — enrichment happens off the request path. */
  setMedia(id, { imageUrl = '', imageAlt = '', imageW = 0, imageH = 0, imageTint = '', videoKind = '', videoId = '' }) {
    prep(
      `UPDATE posts SET image_url = ?, image_alt = ?, image_w = ?, image_h = ?,
                       image_tint = ?, video_kind = ?, video_id = ? WHERE id = ?`
    ).run(imageUrl, imageAlt, imageW, imageH, imageTint, videoKind, videoId, id);
  },

  /**
   * How many posts already use this exact image. A publisher that serves one
   * default social card for every article would otherwise fill the feed with
   * the same picture, which reads worse than no picture at all.
   */
  imageUsage(url) {
    if (!url) return 0;
    return prep('SELECT COUNT(*) AS n FROM posts WHERE image_url = ?').get(url).n;
  },

  /** Link and article posts that have not been enriched yet. */
  needingMedia(limit = 25) {
    return prep(
      `SELECT id, url, source_url, nsfw FROM posts
        WHERE removed = 0 AND image_url = '' AND video_kind = ''
          AND kind IN ('link', 'article') AND (url != '' OR source_url != '')
        ORDER BY created_at DESC LIMIT ?`
    ).all(limit);
  },

  /**
   * Posts whose picture arrived with the feed and so skipped enrichment
   * entirely. They still need their tint computed and their proxy sizes warmed,
   * or the first reader to see them pays for the fetch-and-resize.
   */
  needingWarm(limit = 25) {
    return prep(
      `SELECT id, image_url, nsfw FROM posts
        WHERE removed = 0 AND image_url != '' AND image_tint = ''
        ORDER BY created_at DESC LIMIT ?`
    ).all(limit);
  },

  setTint(id, tint) {
    // A post with no usable tint still needs marking, or it is rescanned
    // forever; '-' is the "we tried" sentinel and reads as empty downstream.
    prep('UPDATE posts SET image_tint = ? WHERE id = ?').run(tint || '-', id);
  },

  /**
   * Most comment activity in the window, weighted by score. This is the
   * "what is worth walking into right now" list, which is a different question
   * from "what is highest rated" — a 400-point thread nobody is replying to is
   * finished, and a 40-point thread with 30 fresh comments is alive.
   */
  trending(windowMs = 86400e3, limit = 6) {
    return prep(
      `SELECT p.id, p.title, p.comment_count, p.score, p.created_at,
              b.slug AS board_slug, b.name AS board_name, b.accent AS board_accent,
              (SELECT COUNT(*) FROM comments c
                WHERE c.post_id = p.id AND c.removed = 0 AND c.created_at > ?) AS recent_comments
         FROM posts p JOIN boards b ON b.id = p.board_id
        WHERE p.removed = 0 AND p.created_at > ?
        ORDER BY recent_comments DESC, p.score DESC LIMIT ?`
    ).all(now() - windowMs, now() - windowMs * 7, limit)
      .filter((r) => r.recent_comments > 0 || r.comment_count > 0);
  },

  /**
   * More like this — same board, nearest in time, excluding the current post.
   * Cheap, and it is what keeps a reader on a second thread after the first.
   */
  related(postId, boardId, limit = 4) {
    return prep(
      `SELECT ${POST_COLUMNS} ${FROM_POSTS}
        WHERE p.board_id = ? AND p.id != ? AND p.removed = 0
        ORDER BY p.score DESC, p.created_at DESC LIMIT ?`
    ).all(boardId, postId, limit).map(shapePost);
  },

  /** Everything filed under one topic, newest first. */
  byTopic(slug, limit = 25, cursor = null) {
    const cur = decodeCursor(cursor);
    const rows = prep(
      `SELECT ${POST_COLUMNS} ${FROM_POSTS}
         JOIN post_topics pt ON pt.post_id = p.id
         JOIN topics t       ON t.id = pt.topic_id
        WHERE t.slug = ? AND p.removed = 0 ${cur ? 'AND p.id < ?' : ''}
        ORDER BY p.created_at DESC, p.id DESC LIMIT ?`
    ).all(...(cur ? [slug, cur.id, limit + 1] : [slug, limit + 1]));
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: page.map(shapePost),
      nextCursor: hasMore ? encodeCursor({ id: page[page.length - 1].id }) : null,
    };
  },

  /**
   * Posts created since a timestamp, for the "N new posts" pill. Counting is
   * far cheaper than re-running the feed, so the client can poll it often.
   */
  newerThan(sinceMs, boardId = null) {
    return prep(
      `SELECT COUNT(*) AS n FROM posts
        WHERE removed = 0 AND created_at > ? ${boardId ? 'AND board_id = ?' : ''}`
    ).get(...(boardId ? [sinceMs, boardId] : [sinceMs])).n;
  },
};

// ---------------------------------------------------------------------------
// Reactions
//
// A vote is a judgement about ranking; a reaction is a remark. Keeping them
// separate means the front page is not distorted by people saying "ha" — and
// gives the large majority who will never write a comment something to do.
// ---------------------------------------------------------------------------

const REACTIONS = ['🔥', '💀', '👀', '🤝', '🧠', '😂'];
const REACTION_SET = new Set(REACTIONS);

const reactions = {
  EMOJI: REACTIONS,

  toggle(userId, targetType, targetId, emoji) {
    if (!REACTION_SET.has(emoji)) return null;
    const tx = db.transaction(() => {
      const existing = prep(
        'SELECT 1 FROM reactions WHERE user_id = ? AND target_type = ? AND target_id = ? AND emoji = ?'
      ).get(userId, targetType, targetId, emoji);

      if (existing) {
        prep('DELETE FROM reactions WHERE user_id = ? AND target_type = ? AND target_id = ? AND emoji = ?')
          .run(userId, targetType, targetId, emoji);
      } else {
        prep('INSERT INTO reactions (user_id, target_type, target_id, emoji, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(userId, targetType, targetId, emoji, now());
      }
      if (targetType === 'post') {
        // Denormalised so a feed page never needs a second query to know
        // whether a post has any reactions at all.
        prep(
          `UPDATE posts SET reaction_count =
             (SELECT COUNT(*) FROM reactions WHERE target_type = 'post' AND target_id = ?)
           WHERE id = ?`
        ).run(targetId, targetId);
      }
      return !existing;
    });
    const on = tx();
    return { emoji, on, counts: this.forTarget(targetType, targetId) };
  },

  forTarget(targetType, targetId) {
    const rows = prep(
      'SELECT emoji, COUNT(*) AS n FROM reactions WHERE target_type = ? AND target_id = ? GROUP BY emoji'
    ).all(targetType, targetId);
    return Object.fromEntries(rows.map((r) => [r.emoji, r.n]));
  },

  /** One query for a whole feed page: {postId: {emoji: count}}. */
  forTargets(targetType, ids) {
    if (!ids.length) return {};
    const rows = prep(
      `SELECT target_id, emoji, COUNT(*) AS n FROM reactions
        WHERE target_type = ? AND target_id IN (${ids.map(() => '?').join(',')})
        GROUP BY target_id, emoji`
    ).all(targetType, ...ids);
    const out = {};
    for (const r of rows) (out[r.target_id] ||= {})[r.emoji] = r.n;
    return out;
  },

  /** Which of these the viewer personally reacted with. */
  mineFor(userId, targetType, ids) {
    if (!userId || !ids.length) return {};
    const rows = prep(
      `SELECT target_id, emoji FROM reactions
        WHERE user_id = ? AND target_type = ? AND target_id IN (${ids.map(() => '?').join(',')})`
    ).all(userId, targetType, ...ids);
    const out = {};
    for (const r of rows) (out[r.target_id] ||= []).push(r.emoji);
    return out;
  },
};

// ---------------------------------------------------------------------------
// Saves
// ---------------------------------------------------------------------------

const saves = {
  toggle(userId, postId) {
    const existing = prep('SELECT 1 FROM saves WHERE user_id = ? AND post_id = ?').get(userId, postId);
    if (existing) {
      prep('DELETE FROM saves WHERE user_id = ? AND post_id = ?').run(userId, postId);
      return false;
    }
    prep('INSERT INTO saves (user_id, post_id, created_at) VALUES (?, ?, ?)').run(userId, postId, now());
    return true;
  },

  forUser(userId, limit = 50) {
    return prep(
      `SELECT ${POST_COLUMNS} ${FROM_POSTS}
         JOIN saves s ON s.post_id = p.id
        WHERE s.user_id = ? AND p.removed = 0
        ORDER BY s.created_at DESC LIMIT ?`
    ).all(userId, limit).map(shapePost);
  },

  /** Which of these post ids has the viewer saved? One indexed lookup. */
  forPosts(userId, ids) {
    if (!userId || !ids.length) return new Set();
    const rows = prep(
      `SELECT post_id FROM saves WHERE user_id = ? AND post_id IN (${ids.map(() => '?').join(',')})`
    ).all(userId, ...ids);
    return new Set(rows.map((r) => r.post_id));
  },

  count(userId) {
    return prep('SELECT COUNT(*) AS n FROM saves WHERE user_id = ?').get(userId).n;
  },
};

function safeJson(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

const MAX_DEPTH = 12;
const pad = (n) => String(n).padStart(10, '0');

const comments = {
  create({ postId, parentId, authorId, body }) {
    const ts = now();
    const tx = db.transaction(() => {
      let depth = 0;
      let parentPath = '';
      if (parentId) {
        const parent = prep('SELECT id, post_id, depth, path FROM comments WHERE id = ?').get(parentId);
        if (!parent || parent.post_id !== postId) throw new Error('BAD_PARENT');
        depth = Math.min(parent.depth + 1, MAX_DEPTH);
        parentPath = parent.path;
      }
      const info = prep(
        `INSERT INTO comments (post_id, parent_id, author_id, body, depth, path, ups, score, confidence, created_at)
         VALUES (?, ?, ?, ?, ?, '', 1, 1, ?, ?)`
      ).run(postId, parentId || null, authorId, body, depth, confidence(1, 0), ts);
      const id = Number(info.lastInsertRowid);
      const path = parentPath ? `${parentPath}.${pad(id)}` : pad(id);
      prep('UPDATE comments SET path = ? WHERE id = ?').run(path, id);
      if (parentId) prep('UPDATE comments SET reply_count = reply_count + 1 WHERE id = ?').run(parentId);
      prep('UPDATE posts SET comment_count = comment_count + 1 WHERE id = ?').run(postId);
      if (authorId) {
        prep('INSERT INTO votes (user_id, target_type, target_id, value, created_at) VALUES (?, ?, ?, 1, ?)')
          .run(authorId, 'comment', id, ts);
        prep('UPDATE users SET comment_karma = comment_karma + 1 WHERE id = ?').run(authorId);
      }
      return id;
    });
    return tx();
  },

  get(id) {
    return prep('SELECT * FROM comments WHERE id = ?').get(id);
  },

  /**
   * Full comment tree for a post. Rows come back in materialised-path order so
   * parents always precede children; the tree is assembled in one pass and
   * siblings are then ordered by the requested key.
   */
  tree(postId, sort = 'best', limit = 800) {
    const rows = prep(
      `SELECT c.id, c.parent_id, c.body, c.depth, c.path, c.ups, c.downs, c.score,
              c.confidence, c.reply_count, c.created_at, c.edited_at, c.removed,
              c.removed_reason,
              u.username AS author, u.role AS author_role, u.avatar_seed AS author_seed
         FROM comments c LEFT JOIN users u ON u.id = c.author_id
        WHERE c.post_id = ? ORDER BY c.path LIMIT ?`
    ).all(postId, limit);

    const byId = new Map();
    const roots = [];
    for (const r of rows) {
      const node = {
        id: r.id,
        parentId: r.parent_id,
        body: r.removed ? '' : r.body,
        depth: r.depth,
        score: r.score,
        ups: r.ups,
        downs: r.downs,
        confidence: r.confidence,
        replyCount: r.reply_count,
        createdAt: r.created_at,
        editedAt: r.edited_at,
        removed: !!r.removed,
        removedReason: r.removed_reason || '',
        author: r.removed ? '[removed]' : r.author || '[deleted]',
        authorRole: r.author_role || 'user',
        authorSeed: r.author_seed || '',
        replies: [],
      };
      byId.set(node.id, node);
      const parent = node.parentId != null ? byId.get(node.parentId) : null;
      if (parent) parent.replies.push(node);
      else roots.push(node);
    }

    const cmp =
      sort === 'new'
        ? (a, b) => b.createdAt - a.createdAt
        : sort === 'old'
          ? (a, b) => a.createdAt - b.createdAt
          : sort === 'top'
            ? (a, b) => b.score - a.score || b.createdAt - a.createdAt
            : sort === 'controversial'
              ? (a, b) => controversy(b) - controversy(a)
              : (a, b) => b.confidence - a.confidence || b.score - a.score;

    const sortTree = (nodes) => {
      nodes.sort(cmp);
      for (const n of nodes) if (n.replies.length) sortTree(n.replies);
    };
    sortTree(roots);

    return { roots, total: rows.length, truncated: rows.length >= limit };
  },

  edit(id, body) {
    prep('UPDATE comments SET body = ?, edited_at = ? WHERE id = ?').run(body, now(), id);
  },

  setRemoved(id, removed, actorId, reason = '') {
    prep('UPDATE comments SET removed = ?, removed_by = ?, removed_reason = ? WHERE id = ?')
      .run(removed ? 1 : 0, actorId, reason, id);
  },

  byAuthor(username, limit = 25) {
    return prep(
      `SELECT c.id, c.post_id, c.body, c.score, c.created_at, c.removed,
              p.title AS post_title, b.slug AS board_slug
         FROM comments c
         JOIN posts p ON p.id = c.post_id
         JOIN boards b ON b.id = p.board_id
         LEFT JOIN users u ON u.id = c.author_id
        WHERE u.username = ? COLLATE NOCASE AND c.removed = 0
        ORDER BY c.created_at DESC LIMIT ?`
    ).all(username, limit);
  },

  countSince(sinceMs) {
    return prep('SELECT COUNT(*) AS n FROM comments WHERE created_at > ? AND removed = 0').get(sinceMs).n;
  },
};

function controversy(node) {
  const total = node.ups + node.downs;
  if (total === 0 || node.ups <= 0 || node.downs <= 0) return 0;
  const balance = node.ups > node.downs ? node.downs / node.ups : node.ups / node.downs;
  return Math.pow(total, balance);
}

// ---------------------------------------------------------------------------
// Votes
// ---------------------------------------------------------------------------

const votes = {
  /**
   * Idempotent vote. `value` is 1, -1, or 0 to clear. Counters, karma and the
   * ranking columns move in one transaction so they can never drift apart.
   */
  cast({ userId, targetType, targetId, value }) {
    const table = targetType === 'post' ? 'posts' : 'comments';
    const tx = db.transaction(() => {
      const target = prep(
        `SELECT id, author_id, ups, downs, created_at FROM ${table} WHERE id = ?`
      ).get(targetId);
      if (!target) throw new Error('NOT_FOUND');

      const existing = prep(
        'SELECT value FROM votes WHERE user_id = ? AND target_type = ? AND target_id = ?'
      ).get(userId, targetType, targetId);
      const prev = existing ? existing.value : 0;
      if (prev === value) return null; // no-op

      if (value === 0) {
        prep('DELETE FROM votes WHERE user_id = ? AND target_type = ? AND target_id = ?')
          .run(userId, targetType, targetId);
      } else if (existing) {
        prep('UPDATE votes SET value = ?, created_at = ? WHERE user_id = ? AND target_type = ? AND target_id = ?')
          .run(value, now(), userId, targetType, targetId);
      } else {
        prep('INSERT INTO votes (user_id, target_type, target_id, value, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(userId, targetType, targetId, value, now());
      }

      const dUp = (value === 1 ? 1 : 0) - (prev === 1 ? 1 : 0);
      const dDown = (value === -1 ? 1 : 0) - (prev === -1 ? 1 : 0);
      const ups = Math.max(0, target.ups + dUp);
      const downs = Math.max(0, target.downs + dDown);
      const score = ups - downs;

      if (targetType === 'post') {
        prep('UPDATE posts SET ups = ?, downs = ?, score = ?, hot = ? WHERE id = ?')
          .run(ups, downs, score, hotRank(score, target.created_at), targetId);
      } else {
        prep('UPDATE comments SET ups = ?, downs = ?, score = ?, confidence = ? WHERE id = ?')
          .run(ups, downs, score, confidence(ups, downs), targetId);
      }

      if (target.author_id && target.author_id !== userId) {
        const column = targetType === 'post' ? 'post_karma' : 'comment_karma';
        prep(`UPDATE users SET ${column} = ${column} + ? WHERE id = ?`).run(value - prev, target.author_id);
      }

      return { score, ups, downs, value };
    });
    return tx();
  },

  /** Viewer's votes for a batch of ids — one indexed query, attached client-side. */
  forTargets(userId, targetType, ids) {
    if (!userId || !ids.length) return {};
    const out = {};
    const CHUNK = 400;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const rows = prep(
        `SELECT target_id, value FROM votes
          WHERE user_id = ? AND target_type = ? AND target_id IN (${slice.map(() => '?').join(',')})`
      ).all(userId, targetType, ...slice);
      for (const r of rows) out[r.target_id] = r.value;
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// Reports & mod log
// ---------------------------------------------------------------------------

const reports = {
  create({ reporterId, targetType, targetId, reason, detail = '' }) {
    return prep(
      `INSERT INTO reports (reporter_id, target_type, target_id, reason, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(reporterId, targetType, targetId, reason, detail, now()).lastInsertRowid;
  },

  queue(status = 'open', limit = 100) {
    return prep(
      `SELECT r.*, u.username AS reporter FROM reports r
         LEFT JOIN users u ON u.id = r.reporter_id
        WHERE r.status = ? ORDER BY r.created_at DESC LIMIT ?`
    ).all(status, limit);
  },

  resolve(id, status, handlerId) {
    prep('UPDATE reports SET status = ?, handled_by = ?, handled_at = ? WHERE id = ?')
      .run(status, handlerId, now(), id);
  },

  openCount() {
    return prep("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'").get().n;
  },
};

const modLog = {
  add({ actorId, action, targetType, targetId, reason = '', boardId = null, ruleId = null }) {
    prep(
      `INSERT INTO mod_actions (actor_id, action, target_type, target_id, reason, board_id, rule_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(actorId, action, targetType, targetId, reason, boardId, ruleId, now());
    // A citation is only real if the counter moves with it.
    if (ruleId) boardRules.cite(ruleId);
  },

  recent(limit = 50) {
    return prep(
      `SELECT m.*, u.username AS actor, r.title AS rule_title, r.position AS rule_position,
              b.slug AS board_slug
         FROM mod_actions m
         LEFT JOIN users u       ON u.id = m.actor_id
         LEFT JOIN board_rules r ON r.id = m.rule_id
         LEFT JOIN boards b      ON b.id = m.board_id
        ORDER BY m.created_at DESC LIMIT ?`
    ).all(limit);
  },
};

module.exports = {
  users,
  boards,
  posts,
  comments,
  votes,
  saves,
  reactions,
  boardMods,
  boardRules,
  reports,
  modLog,
  encodeCursor,
  decodeCursor,
  TIME_WINDOWS,
};
