'use strict';

/**
 * Topics — what the site is talking about, derived rather than curated.
 *
 * Two inputs: the categories publishers already put on their own items, and
 * capitalised proper nouns lifted out of headlines. Trade headlines are
 * formulaic ("Studio Signs Performer", "AVN Awards: X Wins Y"), so the second
 * pass reliably surfaces the performers, studios and statutes currently in the
 * news — and stops surfacing them when coverage moves on, which a hand-written
 * list of names never does.
 *
 * That distinction matters: nobody here maintains a database of people. A name
 * exists as a topic for exactly as long as the press is publishing about it.
 */

const { db } = require('./db');

// Words that start sentences and headline clauses, so they capitalise without
// being proper nouns. Without this every topic list is led by "The" and "New".
const STOPWORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'or',
  'the', 'to', 'with', 'after', 'over', 'under', 'amid', 'says', 'said', 'new', 'more',
  'this', 'that', 'these', 'those', 'his', 'her', 'their', 'its', 'how', 'why', 'what',
  'when', 'where', 'who', 'will', 'now', 'top', 'best', 'first', 'last', 'next', 'here',
  'report', 'reports', 'exclusive', 'update', 'updates', 'video', 'watch', 'read',
  'interview', 'opinion', 'review', 'launches', 'launch', 'announces', 'announced',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',

  // Headline furniture. Trade and entertainment feeds title-case whole clauses
  // ("Additional Cast Announced", "Ending Theme Revealed"), which without this
  // list dominates the trends rail with sentence fragments rather than subjects.
  'cast', 'casts', 'theme', 'song', 'opening', 'ending', 'season', 'episode',
  'film', 'movie', 'series', 'trailer', 'premiere', 'premieres', 'release',
  'released', 'releases', 'reveal', 'reveals', 'revealed', 'adds', 'added',
  'debut', 'debuts', 'confirms', 'confirmed', 'unveils', 'returns', 'gets',
  'streaming', 'stream', 'english', 'japanese', 'japan', 'dub', 'sub', 'subtitles',
  'manga', 'anime', 'game', 'games', 'novel', 'volume', 'chapter', 'staff',
  'director', 'studio', 'part', 'arc', 'special', 'ova', 'character', 'characters',
  'visual', 'teaser', 'promo', 'additional', 'main', 'second', 'third', 'final',
  'full', 'official', 'live-action', 'adaptation', 'awards', 'award', 'week',
  'year', 'day', 'sales', 'billion', 'million',
]);

const slugify = (text) => String(text)
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 60);

/**
 * Is this headline set in Title Case?
 *
 * This matters more than any other rule here. Extraction leans entirely on
 * capitalisation to tell a subject from an ordinary word — and in a headline
 * where *every* word is capitalised, capitalisation carries no information at
 * all. Run the extractor over "Verification Law Takes Effect June 12" and it
 * confidently reports "Verification Law Takes" as a subject.
 *
 * So: measure it, and when the headline is Title Case, fall back to acronyms
 * only. Half the trade press writes this way, and a wrong topic is worse than
 * a missing one — it becomes a page, a filter and a trend nobody meant.
 */
function isTitleCase(text) {
  const words = text.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w) && w.length > 3);
  if (words.length < 4) return false;
  const capitalised = words.filter((w) => /^[A-Z]/.test(w)).length;
  return capitalised / words.length > 0.7;
}

/**
 * Pull capitalised runs of one to three words out of a headline.
 *
 * A single capitalised word is only kept when it is unusual enough to be worth
 * a topic page — all-caps acronyms (FSC, AVN) or a word that is not a stopword
 * and not merely the first word of the sentence.
 */
function properNouns(headline) {
  const text = String(headline || '').replace(/[‘’]/g, "'");
  const found = [];

  /** Trim headline furniture off both ends and accept what is left. */
  const keep = (phrase, { allowSingle }) => {
    const words = phrase.trim().replace(/[.,:;!?]+$/, '').split(/\s+/);
    while (words.length && STOPWORDS.has(words[0].toLowerCase())) words.shift();
    while (words.length && STOPWORDS.has(words[words.length - 1].toLowerCase())) words.pop();
    if (!words.length) return;
    if (words.length === 1 && !allowSingle && !/^[A-Z0-9]{2,}$/.test(words[0])) return;
    const out = words.join(' ');
    if (out.length < 3 || out.length > 48) return;
    // Years, volume numbers and season codes capitalise like acronyms but are
    // not subjects: require at least two letters somewhere.
    if ((out.match(/[A-Za-z]/g) || []).length < 2) return;
    found.push(out);
  };

  if (isTitleCase(text)) {
    // Capitalisation is meaningless here, so only shouting counts. Runs of
    // adjacent all-caps tokens stay together ("TAKE IT DOWN"); isolated ones
    // stand alone ("BLEACH", "FSC").
    for (const run of text.match(/\b[A-Z0-9][A-Z0-9'&.-]+(?:\s+[A-Z0-9][A-Z0-9'&.-]+)*/g) || []) {
      keep(run, { allowSingle: true });
    }
  } else {
    // Sentence case: a capital letter that is not the first word is a real
    // signal, so single names ("Aylo", "Arizona") are worth keeping too.
    const RUN = /\b([A-Z][\w'&.-]*(?:\s+(?:of|the|and|de|van|von)\s+[A-Z][\w'&.-]*|\s+[A-Z][\w'&.-]*){0,2})/g;
    let match;
    while ((match = RUN.exec(text))) {
      keep(match[1], { allowSingle: match.index > 0 });
    }
  }

  // Dedupe, and drop a phrase wholly contained in a longer one.
  const unique = [...new Set(found)];
  return unique
    .filter((p) => !unique.some((other) => other !== p && other.includes(p)))
    .slice(0, 6);
}

const insertTopic = db.prepare(`
  INSERT INTO topics (slug, label, kind, post_count, last_seen_at, created_at)
  VALUES (?, ?, ?, 0, ?, ?)
  ON CONFLICT(slug) DO UPDATE SET last_seen_at = excluded.last_seen_at
`);
const topicIdBySlug = db.prepare('SELECT id FROM topics WHERE slug = ?');
const linkTopic = db.prepare('INSERT OR IGNORE INTO post_topics (post_id, topic_id) VALUES (?, ?)');
const bumpTopic = db.prepare('UPDATE topics SET post_count = post_count + 1 WHERE id = ?');

/**
 * Attach topics to a post. Safe to call more than once for the same post —
 * the join table's primary key makes the link idempotent, and the counter only
 * moves when the link is genuinely new.
 *
 * @param {number} postId
 * @param {{title?:string, tags?:string[]}} input
 * @returns {string[]} the labels that were attached
 */
function attach(postId, { title = '', tags = [], tagKind = 'tag' } = {}) {
  const now = Date.now();
  const candidates = [
    ...tags.map((label) => ({ label, kind: tagKind })),
    ...properNouns(title).map((label) => ({ label, kind: 'name' })),
  ];

  const attached = [];
  const tx = db.transaction(() => {
    const seen = new Set();
    for (const { label, kind } of candidates) {
      const slug = slugify(label);
      if (!slug || slug.length < 2 || seen.has(slug)) continue;
      seen.add(slug);
      insertTopic.run(slug, label, kind, now, now);
      const row = topicIdBySlug.get(slug);
      if (!row) continue;
      if (linkTopic.run(postId, row.id).changes) bumpTopic.run(row.id);
      attached.push(label);
      if (attached.length >= 10) break;
    }
  });
  tx();
  return attached;
}

/**
 * What is trending: topics whose posts landed inside the window, ranked by how
 * many. This is the "Trends" rail, and it is genuinely live because it is
 * computed from the last N hours of ingest rather than a stored counter.
 */
/**
 * What is trending, for the news rail.
 *
 * `content` topics are excluded on purpose. Tube-site APIs return keyword lists
 * describing what is *in* a clip, and those are useful for browsing the shelf —
 * but they are not subjects anybody is reporting on, and left in they bury
 * every actual news topic under a wall of body-part nouns. Two different
 * things wearing the same shape.
 */
function trending({ windowMs = 3 * 86400e3, limit = 12, kinds = ['tag', 'name'] } = {}) {
  const slots = kinds.map(() => '?').join(',');
  return db.prepare(`
    SELECT t.slug, t.label, t.kind, COUNT(*) AS recent, t.post_count AS total
      FROM post_topics pt
      JOIN topics t ON t.id = pt.topic_id
      JOIN posts p  ON p.id = pt.post_id
     WHERE p.removed = 0 AND p.created_at > ? AND t.kind IN (${slots})
     GROUP BY t.id
     HAVING recent >= 2
     ORDER BY recent DESC, total DESC
     LIMIT ?
  `).all(Date.now() - windowMs, ...kinds, limit);
}

function bySlug(slug) {
  return db.prepare('SELECT slug, label, kind, post_count FROM topics WHERE slug = ?').get(slug) || null;
}

function forPosts(ids) {
  if (!ids.length) return new Map();
  const rows = db.prepare(`
    SELECT pt.post_id, t.slug, t.label
      FROM post_topics pt JOIN topics t ON t.id = pt.topic_id
     WHERE pt.post_id IN (${ids.map(() => '?').join(',')})
     ORDER BY t.post_count DESC
  `).all(...ids);
  const map = new Map();
  for (const row of rows) {
    const list = map.get(row.post_id) || [];
    if (list.length < 4) list.push({ slug: row.slug, label: row.label });
    map.set(row.post_id, list);
  }
  return map;
}

module.exports = { attach, trending, bySlug, forPosts, properNouns, slugify };
