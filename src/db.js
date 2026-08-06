'use strict';

/**
 * SQLite data layer.
 *
 * Every worker process opens its own connection to the same file. WAL mode lets
 * all of them read concurrently while one writes; `busy_timeout` makes the
 * losers of a write race wait instead of throwing SQLITE_BUSY.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'afterdark.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL'); // durable across crashes, not across power loss
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');
db.pragma('cache_size = -32000'); // 32 MB page cache per process
db.pragma('mmap_size = 268435456'); // 256 MB
db.pragma('temp_store = MEMORY');

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY,
  username       TEXT NOT NULL COLLATE NOCASE,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'user',   -- user | mod | admin
  bio            TEXT NOT NULL DEFAULT '',
  avatar_seed    TEXT NOT NULL DEFAULT '',
  post_karma     INTEGER NOT NULL DEFAULT 0,
  comment_karma  INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL DEFAULT 0,
  banned_until   INTEGER NOT NULL DEFAULT 0,
  ban_reason     TEXT NOT NULL DEFAULT '',
  age_ok_at      INTEGER NOT NULL DEFAULT 0,
  age_method     TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  ua          TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS boards (
  id           INTEGER PRIMARY KEY,
  slug         TEXT NOT NULL COLLATE NOCASE,
  name         TEXT NOT NULL,
  tagline      TEXT NOT NULL DEFAULT '',
  description  TEXT NOT NULL DEFAULT '',
  kind         TEXT NOT NULL DEFAULT 'discussion', -- discussion | news
  accent       TEXT NOT NULL DEFAULT '#e0245e',
  icon         TEXT NOT NULL DEFAULT '#',
  rules        TEXT NOT NULL DEFAULT '[]',         -- JSON array of strings
  member_count INTEGER NOT NULL DEFAULT 0,
  post_count   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  sort_order   INTEGER NOT NULL DEFAULT 100
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_boards_slug ON boards(slug COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS board_subs (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  board_id   INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, board_id)
);
CREATE INDEX IF NOT EXISTS idx_subs_board ON board_subs(board_id);

CREATE TABLE IF NOT EXISTS posts (
  id            INTEGER PRIMARY KEY,
  board_id      INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  author_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind          TEXT NOT NULL DEFAULT 'text',      -- text | link | article
  title         TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  url           TEXT NOT NULL DEFAULT '',
  flair         TEXT NOT NULL DEFAULT '',
  -- newsroom fields (kind = 'article')
  source_name   TEXT NOT NULL DEFAULT '',
  source_url    TEXT NOT NULL DEFAULT '',
  wire_guid     TEXT,
  published_at  INTEGER NOT NULL DEFAULT 0,
  -- media enrichment (see src/media.js): the publisher's own OG image, and a
  -- recognised video id where the link points at one
  image_url     TEXT NOT NULL DEFAULT '',
  image_alt     TEXT NOT NULL DEFAULT '',
  image_w       INTEGER NOT NULL DEFAULT 0,
  image_h       INTEGER NOT NULL DEFAULT 0,
  image_tint    TEXT NOT NULL DEFAULT '',
  video_kind    TEXT NOT NULL DEFAULT '',
  video_id      TEXT NOT NULL DEFAULT '',
  -- counters
  ups           INTEGER NOT NULL DEFAULT 0,
  downs         INTEGER NOT NULL DEFAULT 0,
  score         INTEGER NOT NULL DEFAULT 0,
  hot           REAL NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  edited_at     INTEGER NOT NULL DEFAULT 0,
  locked        INTEGER NOT NULL DEFAULT 0,
  pinned        INTEGER NOT NULL DEFAULT 0,
  removed       INTEGER NOT NULL DEFAULT 0,
  removed_by    INTEGER,
  removed_reason TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_wire ON posts(wire_guid) WHERE wire_guid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_hot        ON posts(removed, hot DESC);
CREATE INDEX IF NOT EXISTS idx_posts_new        ON posts(removed, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_top        ON posts(removed, score DESC);
CREATE INDEX IF NOT EXISTS idx_posts_board_hot  ON posts(board_id, removed, pinned DESC, hot DESC);
CREATE INDEX IF NOT EXISTS idx_posts_board_new  ON posts(board_id, removed, pinned DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_board_top  ON posts(board_id, removed, pinned DESC, score DESC);
CREATE INDEX IF NOT EXISTS idx_posts_author     ON posts(author_id, created_at DESC);
-- The newsroom orders by when the publisher ran the story, not when we ingested it.
CREATE INDEX IF NOT EXISTS idx_posts_published  ON posts(removed, published_at DESC);

CREATE TABLE IF NOT EXISTS comments (
  id          INTEGER PRIMARY KEY,
  post_id     INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  parent_id   INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  author_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body        TEXT NOT NULL,
  depth       INTEGER NOT NULL DEFAULT 0,
  path        TEXT NOT NULL DEFAULT '',           -- materialised path: 0000012.0000045
  ups         INTEGER NOT NULL DEFAULT 0,
  downs       INTEGER NOT NULL DEFAULT 0,
  score       INTEGER NOT NULL DEFAULT 0,
  confidence  REAL NOT NULL DEFAULT 0,            -- Wilson lower bound, for "best"
  reply_count INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  edited_at   INTEGER NOT NULL DEFAULT 0,
  removed     INTEGER NOT NULL DEFAULT 0,
  removed_by  INTEGER,
  removed_reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_comments_post   ON comments(post_id, path);
CREATE INDEX IF NOT EXISTS idx_comments_best   ON comments(post_id, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_comments_author ON comments(author_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);

CREATE TABLE IF NOT EXISTS votes (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,                      -- post | comment
  target_id   INTEGER NOT NULL,
  value       INTEGER NOT NULL,                   -- 1 | -1
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_votes_target ON votes(target_type, target_id);

-- Saving a post is the strongest "come back later" signal a reader gives us,
-- and the cheapest retention feature there is.
CREATE TABLE IF NOT EXISTS saves (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX IF NOT EXISTS idx_saves_user ON saves(user_id, created_at DESC);

-- Communities are created by users, so a board needs an owner, a moderator
-- roster, and rules that are rows rather than a JSON blob.
CREATE TABLE IF NOT EXISTS board_mods (
  board_id   INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'mod',          -- owner | mod
  added_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (board_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_board_mods_user ON board_mods(user_id);

-- The novel part.
--
-- On most forums a rule is prose in a sidebar and a removal is a free-text
-- reason, so nobody can tell whether a rule is enforced, enforced unevenly, or
-- dead letter. Here a rule is a numbered row, every removal must cite one, and
-- the citation count is public. That makes moderation auditable by the people
-- it is applied to: a rule with 400 enforcements and one with zero are visibly
-- different objects, and a community can see its own moderation drifting.
CREATE TABLE IF NOT EXISTS board_rules (
  id          INTEGER PRIMARY KEY,
  board_id    INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL DEFAULT 1,
  title       TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  cited_count INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  retired_at  INTEGER NOT NULL DEFAULT 0        -- kept for the audit trail
);
CREATE INDEX IF NOT EXISTS idx_board_rules ON board_rules(board_id, position);

-- Notifications: replies, mentions, and moderator action on your own content.
-- Written at the moment the thing happens rather than derived on read, because
-- "what happened while I was away" is a question about the past that gets
-- expensive to reconstruct once a thread has ten thousand comments.
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,          -- reply | comment_reply | mention | mod | award | system
  actor_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  post_id    INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  comment_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  title      TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL DEFAULT '',
  read_at    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read_at, created_at DESC);

-- Direct messages. One row per pair, ordered so (a,b) and (b,a) are the same
-- conversation and the unique index can enforce it.
CREATE TABLE IF NOT EXISTS conversations (
  id         INTEGER PRIMARY KEY,
  low_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  high_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_at    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_pair ON conversations(low_id, high_id);
CREATE INDEX IF NOT EXISTS idx_conv_recent ON conversations(last_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body            TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  read_at         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at);

-- Awards. Deliberately not a currency: every account gets a small monthly
-- allowance, so giving one costs attention rather than money. A paid award is
-- a way to buy visibility, which is the opposite of what a vote is for.
CREATE TABLE IF NOT EXISTS award_grants (
  id          INTEGER PRIMARY KEY,
  giver_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,          -- post | comment
  target_id   INTEGER NOT NULL,
  award       TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_awards_target ON award_grants(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_awards_giver ON award_grants(giver_id, created_at DESC);

-- Custom feeds: a named set of communities, read as one feed.
CREATE TABLE IF NOT EXISTS custom_feeds (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug       TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cfeed_slug ON custom_feeds(user_id, slug);

CREATE TABLE IF NOT EXISTS custom_feed_boards (
  feed_id  INTEGER NOT NULL REFERENCES custom_feeds(id) ON DELETE CASCADE,
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  PRIMARY KEY (feed_id, board_id)
);

-- Blocking is one-directional and hides the blocked party's content from the
-- blocker, not the other way round — a block should never be a way to make
-- yourself unreadable to someone who is documenting your behaviour.
CREATE TABLE IF NOT EXISTS blocks (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, blocked_id)
);

-- The directory: adult platforms, grouped by what they actually are.
CREATE TABLE IF NOT EXISTS sites (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  url        TEXT NOT NULL,
  category   TEXT NOT NULL,
  blurb      TEXT NOT NULL DEFAULT '',
  nsfw       INTEGER NOT NULL DEFAULT 1,
  hidden     INTEGER NOT NULL DEFAULT 0,
  clicks     INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 100,
  added_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sites_cat ON sites(hidden, category, sort_order);

-- Emoji reactions sit alongside the up/down vote rather than replacing it.
-- The vote decides ranking; reactions are how people say something *about* a
-- post, which is a much lower-effort contribution than writing a comment and
-- therefore the one most readers will actually make.
CREATE TABLE IF NOT EXISTS reactions (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,                      -- post | comment
  target_id   INTEGER NOT NULL,
  emoji       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, target_type, target_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_reactions_target ON reactions(target_type, target_id);

-- Topics are derived from what the wire actually publishes — feed categories
-- plus proper nouns lifted from headlines — rather than a list we maintain.
-- A performer, studio or law trends here exactly when the press is writing
-- about it, and stops when they stop.
CREATE TABLE IF NOT EXISTS topics (
  id          INTEGER PRIMARY KEY,
  slug        TEXT NOT NULL,
  label       TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'tag',        -- tag | name
  post_count  INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_topics_slug ON topics(slug);
CREATE INDEX IF NOT EXISTS idx_topics_recent ON topics(last_seen_at DESC, post_count DESC);

CREATE TABLE IF NOT EXISTS post_topics (
  post_id  INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, topic_id)
);
CREATE INDEX IF NOT EXISTS idx_post_topics_topic ON post_topics(topic_id, post_id DESC);

-- The wire's source registry. Config lives in src/sources.js; this table holds
-- operator overrides and the health of the last run.
CREATE TABLE IF NOT EXISTS sources (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  url         TEXT NOT NULL,
  adapter     TEXT NOT NULL DEFAULT 'rss',        -- rss | json
  board_slug  TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'news',       -- news | video
  nsfw        INTEGER NOT NULL DEFAULT 0,
  enabled     INTEGER NOT NULL DEFAULT 1,
  builtin     INTEGER NOT NULL DEFAULT 0,
  verified    INTEGER NOT NULL DEFAULT 0,
  note        TEXT NOT NULL DEFAULT '',
  items_path  TEXT NOT NULL DEFAULT '',
  field_map   TEXT,
  last_run_at INTEGER NOT NULL DEFAULT 0,
  last_ok_at  INTEGER NOT NULL DEFAULT 0,
  last_status TEXT NOT NULL DEFAULT '',
  last_error  TEXT NOT NULL DEFAULT '',
  items_seen  INTEGER NOT NULL DEFAULT 0,
  items_added INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  id          INTEGER PRIMARY KEY,
  reporter_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  target_type TEXT NOT NULL,
  target_id   INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open',       -- open | actioned | dismissed
  created_at  INTEGER NOT NULL,
  handled_by  INTEGER,
  handled_at  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_type, target_id);

CREATE TABLE IF NOT EXISTS mod_actions (
  id          INTEGER PRIMARY KEY,
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   INTEGER NOT NULL,
  reason      TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_modlog_time ON mod_actions(created_at DESC);

-- Votes, saves, reactions and awards point at posts and comments
-- polymorphically — (target_type, target_id) rather than a real reference — so
-- SQLite cannot cascade them on delete. Left alone, a hard-deleted post orphans
-- its votes, SQLite recycles the freed rowid for the next post, and the new
-- author's self-upvote collides with a stranger's vote on a row that no longer
-- exists. These triggers do the cascade the schema cannot express.
CREATE TRIGGER IF NOT EXISTS posts_cleanup AFTER DELETE ON posts BEGIN
  DELETE FROM votes        WHERE target_type = 'post' AND target_id = old.id;
  DELETE FROM reactions    WHERE target_type = 'post' AND target_id = old.id;
  DELETE FROM award_grants WHERE target_type = 'post' AND target_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS comments_cleanup AFTER DELETE ON comments BEGIN
  DELETE FROM votes        WHERE target_type = 'comment' AND target_id = old.id;
  DELETE FROM reactions    WHERE target_type = 'comment' AND target_id = old.id;
  DELETE FROM award_grants WHERE target_type = 'comment' AND target_id = old.id;
END;

-- Full-text search over posts. Kept in sync by triggers.
CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
  title, body, content='posts', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS posts_fts_ai AFTER INSERT ON posts BEGIN
  INSERT INTO posts_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS posts_fts_ad AFTER DELETE ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS posts_fts_au AFTER UPDATE OF title, body ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
  INSERT INTO posts_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
`;

db.exec(SCHEMA);

// ---------------------------------------------------------------------------
// Migrations
//
// CREATE TABLE IF NOT EXISTS is a no-op on an existing table, so columns added
// after first release have to be applied by hand. Each entry is idempotent:
// applied only when the column is genuinely absent.
// ---------------------------------------------------------------------------

const COLUMN_MIGRATIONS = [
  ['posts', 'image_url', "TEXT NOT NULL DEFAULT ''"],
  ['posts', 'image_alt', "TEXT NOT NULL DEFAULT ''"],
  ['posts', 'image_w', 'INTEGER NOT NULL DEFAULT 0'],
  ['posts', 'image_h', 'INTEGER NOT NULL DEFAULT 0'],
  ['posts', 'image_tint', "TEXT NOT NULL DEFAULT ''"],
  ['posts', 'video_kind', "TEXT NOT NULL DEFAULT ''"],
  ['posts', 'video_id', "TEXT NOT NULL DEFAULT ''"],
  // Explicit-media handling, video metadata and source attribution.
  ['posts', 'nsfw', 'INTEGER NOT NULL DEFAULT 0'],
  ['posts', 'duration', 'INTEGER NOT NULL DEFAULT 0'],  // seconds
  ['posts', 'views', 'INTEGER NOT NULL DEFAULT 0'],     // as reported by the source
  ['posts', 'source_id', "TEXT NOT NULL DEFAULT ''"],
  ['posts', 'reaction_count', 'INTEGER NOT NULL DEFAULT 0'],
  ['boards', 'nsfw', 'INTEGER NOT NULL DEFAULT 0'],
  ['boards', 'created_by', 'INTEGER'],
  ['boards', 'banner_tint', "TEXT NOT NULL DEFAULT ''"],
  ['boards', 'official', 'INTEGER NOT NULL DEFAULT 0'],
  // Does this board's output belong in Home and Popular, or is it a place you
  // go? A high-volume shelf drowns everything slower than it.
  ['boards', 'firehose', 'INTEGER NOT NULL DEFAULT 0'],   // seeded, not user-made
  ['mod_actions', 'board_id', 'INTEGER'],
  ['mod_actions', 'rule_id', 'INTEGER'],
  // Preferences follow the account rather than the browser.
  ['users', 'prefs', "TEXT NOT NULL DEFAULT '{}'"],
];

// Indexes for columns the migrations above may have just added — CREATE INDEX
// in the schema block would fail on an old database where the column is absent.
const INDEX_MIGRATIONS = [
  'CREATE INDEX IF NOT EXISTS idx_posts_video ON posts(removed, board_id, views DESC)',
  'CREATE INDEX IF NOT EXISTS idx_posts_source ON posts(source_id, created_at DESC)',
];

function migrate() {
  const applied = [];
  for (const [table, column, definition] of COLUMN_MIGRATIONS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (columns.includes(column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    applied.push(`${table}.${column}`);
  }
  for (const sql of INDEX_MIGRATIONS) db.exec(sql);
  if (applied.length) console.log(`[afterdark] migrated: ${applied.join(', ')}`);
  return applied;
}

migrate();

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

/** Drop expired sessions. Cheap enough to run on an interval in worker 1. */
function pruneSessions() {
  return db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()).changes;
}

// SQLite's math functions are a compile-time option, so rather than depend on
// LOG10 being present we expose the ranking maths as a registered function.
const { hotRank } = require('./ranking');
db.function('hot_rank', { deterministic: true }, (score, createdAt) => hotRank(score, createdAt));

/**
 * Recompute `hot` for recent posts so the front page decays over time rather
 * than only moving when someone votes.
 */
const reheat = db.prepare(
  'UPDATE posts SET hot = hot_rank(score, created_at) WHERE created_at > ?'
);

function reheatRecentPosts(windowMs = 1000 * 60 * 60 * 24 * 14) {
  return reheat.run(Date.now() - windowMs).changes;
}

module.exports = { db, DB_PATH, pruneSessions, reheatRecentPosts };
