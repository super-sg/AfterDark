'use strict';

const express = require('express');
const { db, pruneSessions } = require('./db');
const store = require('./store');
const auth = require('./auth');
const mod = require('./moderation');
const { TTLCache } = require('./cache');
const { ingest } = require('./wire');
const { enrichPending } = require('./enrich');
const { parseVideo } = require('./media');
const imageproxy = require('./imageproxy');
const topics = require('./topics');
const sources = require('./sources');
const ads = require('./ads');
const sites = require('./sites');
const social = require('./social');

const router = express.Router();

// Feeds are the hot path: cache the *shared* part of the response briefly and
// stitch the viewer's own votes on per request.
const feedCache = new TTLCache({ max: 800, ttl: 4000 });
const boardCache = new TTLCache({ max: 32, ttl: 30000 });
const statsCache = new TTLCache({ max: 8, ttl: 10000 });
const postCache = new TTLCache({ max: 2000, ttl: 3000 });

const AGE_MODE = process.env.AGE_ASSURANCE_MODE || 'self';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const asInt = (v, fallback = 0) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};

function fail(res, status, error, extra = {}) {
  return res.status(status).json({ error, ...extra });
}

/** Wraps an async handler so rejections reach the error middleware. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Blocks state-changing requests that did not originate from this site. */
function sameOrigin(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.get('origin');
  if (!origin) return next(); // non-browser client (curl, mobile app)
  try {
    if (new URL(origin).host !== req.get('host')) {
      return fail(res, 403, 'Cross-origin request rejected.');
    }
  } catch {
    return fail(res, 403, 'Bad Origin header.');
  }
  next();
}

/** Content endpoints require the age interstitial to have been passed. */
function requireAge(req, res, next) {
  if (req.ageOk) return next();
  return res.status(403).json({ error: 'Age confirmation required.', ageRequired: true });
}

function rateLimit(action, keyFn) {
  const { limit, windowMs } = mod.LIMITS[action];
  return (req, res, next) => {
    const key = `${action}:${keyFn(req)}`;
    if (!mod.allow(key, limit, windowMs)) {
      res.set('Retry-After', String(mod.retryAfter(key)));
      return fail(res, 429, "You're doing that too often. Give it a minute.");
    }
    next();
  };
}

const userKey = (req) => (req.user ? `u${req.user.id}` : `ip${req.ip}`);
const ipKey = (req) => `ip${req.ip}`;

function attachVotes(req, items, type = 'post') {
  if (!req.user || !items.length) return items;
  const map = store.votes.forTargets(req.user.id, type, items.map((i) => i.id));
  for (const item of items) item.myVote = map[item.id] || 0;
  if (type === 'post') {
    const saved = store.saves.forPosts(req.user.id, items.map((i) => i.id));
    for (const item of items) item.saved = saved.has(item.id);
  }
  return items;
}

const IMAGE_SLOTS = ['thumb', 'card', 'wide', 'hero'];

/**
 * Rewrite remote image URLs into signed same-origin proxy URLs, at the sizes
 * the layout actually renders. The client never sees a publisher URL, so the
 * reader's browser never contacts one.
 *
 * Explicit artwork gets a second, blurred set. The card renders the blurred
 * rendition until the reader chooses to see it — the site is adults-only, but
 * "adults only" is not the same as "everything, immediately, on the front page
 * in an open-plan office". The sharp URLs travel with the payload so a reveal
 * is instant; the gate is against ambush, not against the reader.
 */
function attachImages(items) {
  for (const item of items) {
    if (!item.image) continue;
    const slots = (suffix) => Object.fromEntries(
      IMAGE_SLOTS.map((slot) => [slot, imageproxy.proxyUrl(item.image, `${slot}${suffix}`)])
    );
    item.img = slots('');
    if (item.nsfw) item.imgBlur = slots('-blur');
    delete item.image; // the origin URL is server-side detail
  }
  return items;
}

/** One query each for reactions and topics across the whole page, not per item. */
function attachExtras(req, items) {
  if (!items.length) return items;
  const ids = items.map((i) => i.id);

  const counts = store.reactions.forTargets('post', ids);
  const mine = req.user ? store.reactions.mineFor(req.user.id, 'post', ids) : {};
  const byPost = topics.forPosts(ids);
  const awardsByPost = social.awards.forTargets('post', ids);

  for (const item of items) {
    item.reactions = counts[item.id] || {};
    item.myReactions = mine[item.id] || [];
    item.topics = byPost.get(item.id) || [];
    item.awards = awardsByPost[item.id] || [];
  }
  return items;
}

/**
 * Drop posts by anyone the viewer has blocked. Applied on read rather than by
 * excluding them from the query, because the block list is tiny and per-viewer
 * while the feed query is shared and cached — filtering here keeps one cache
 * entry serving everybody.
 */
function hideBlocked(req, items) {
  if (!req.user) return items;
  const blocked = social.blocks.idsFor(req.user.id);
  if (!blocked.length) return items;
  const names = new Set(blocked.map((id) => store.users.byId(id)?.username?.toLowerCase()).filter(Boolean));
  return items.filter((p) => !names.has(String(p.author).toLowerCase()));
}

const decorate = (req, items) => attachExtras(req, attachImages(attachVotes(req, hideBlocked(req, items))));

function canEdit(req, authorName) {
  if (!req.user) return false;
  return req.user.username.toLowerCase() === String(authorName).toLowerCase()
    || req.user.role === 'admin'
    || req.user.role === 'mod';
}

const isStaff = (req) => !!req.user && (req.user.role === 'mod' || req.user.role === 'admin');

// ---------------------------------------------------------------------------
// Auth & identity
// ---------------------------------------------------------------------------

const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,19}$/;
const RESERVED = new Set(['admin', 'administrator', 'mod', 'moderator', 'afterdark', 'staff', 'root', 'system', 'deleted', 'removed']);

router.post('/auth/register', rateLimit('register', ipKey), (req, res) => {
  const username = mod.clean(req.body?.username, 20);
  const password = String(req.body?.password ?? '');

  if (!USERNAME_RE.test(username)) {
    return fail(res, 400, 'Usernames are 3–20 characters: letters, numbers, _ and -, starting with a letter or number.');
  }
  const admins = String(process.env.ADMIN_USERS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (RESERVED.has(username.toLowerCase()) && !admins.includes(username.toLowerCase())) {
    return fail(res, 400, 'That username is reserved.');
  }
  if (password.length < 10) return fail(res, 400, 'Use a password of at least 10 characters.');
  if (password.length > 200) return fail(res, 400, 'That password is too long.');
  if (store.users.byUsername(username)) return fail(res, 409, 'That username is taken.');

  const role = admins.includes(username.toLowerCase()) ? 'admin' : 'user';
  let id;
  try {
    id = store.users.create(username, auth.hashPassword(password), role);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return fail(res, 409, 'That username is taken.');
    throw err;
  }

  // New accounts land in the default boards so the front page isn't empty.
  for (const slug of ['newsroom', 'discussion', 'industry']) {
    const board = store.boards.bySlug(slug);
    if (board) {
      try {
        store.boards.subscribe(id, board.id);
      } catch { /* already subscribed */ }
    }
  }

  const { token } = auth.createSession(id, req.get('user-agent'));
  res.cookie(auth.SESSION_COOKIE, token, auth.cookieOpts(auth.SESSION_TTL_MS));
  res.status(201).json({ user: { id, username, role, postKarma: 1, commentKarma: 0 } });
});

router.post('/auth/login', rateLimit('login', ipKey), (req, res) => {
  const username = mod.clean(req.body?.username, 20);
  const password = String(req.body?.password ?? '');
  const row = store.users.byUsername(username);

  // Always run a hash comparison so timing does not reveal whether the account exists.
  const ok = row
    ? auth.verifyPassword(password, row.password_hash)
    : auth.verifyPassword(password, auth.hashPassword('placeholder-never-matches'));
  if (!row || !ok) return fail(res, 401, 'Wrong username or password.');

  const { token } = auth.createSession(row.id, req.get('user-agent'));
  res.cookie(auth.SESSION_COOKIE, token, auth.cookieOpts(auth.SESSION_TTL_MS));
  res.json({
    user: {
      id: row.id,
      username: row.username,
      role: row.role,
      postKarma: row.post_karma,
      commentKarma: row.comment_karma,
      banned: row.banned_until > Date.now(),
    },
  });
});

router.post('/auth/logout', (req, res) => {
  auth.destroySession(req.cookies?.[auth.SESSION_COOKIE]);
  res.clearCookie(auth.SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  res.json({
    user: req.user,
    ageOk: req.ageOk,
    ageMode: AGE_MODE,
    subscriptions: req.user ? store.boards.subscriptionsFor(req.user.id) : [],
    openReports: isStaff(req) ? store.reports.openCount() : 0,
    unread: req.user ? social.notifications.unreadCount(req.user.id) : 0,
    messagesUnread: req.user ? social.messages.unreadCount(req.user.id) : 0,
    feeds: req.user ? social.customFeeds.list(req.user.id) : [],
    prefs: req.user ? social.prefs.get(req.user.id) : social.prefs.DEFAULTS,
    awardsRemaining: req.user ? social.awards.remaining(req.user.id) : 0,
    moderates: req.user ? store.boardMods.boardsFor(req.user.id) : [],
  });
});

router.post('/me/bio', auth.requireUser, (req, res) => {
  const bio = mod.clean(req.body?.bio, 500);
  const verdict = mod.screen(bio);
  if (!verdict.ok) return fail(res, 422, verdict.reason);
  store.users.updateBio(req.user.id, bio);
  res.json({ ok: true, bio });
});

// --- age gate ---------------------------------------------------------------

router.post('/age/confirm', (req, res) => {
  if (AGE_MODE !== 'self') {
    return fail(res, 400, 'This deployment requires verification through the configured age-assurance provider.', {
      verifyUrl: process.env.AGE_VERIFY_URL || '',
    });
  }
  if (req.body?.confirm !== true) return fail(res, 400, 'Confirmation required.');
  const expiresAt = Date.now() + auth.AGE_TTL_MS;
  res.cookie(auth.AGE_COOKIE, auth.signAgeToken(expiresAt), auth.cookieOpts(auth.AGE_TTL_MS));
  if (req.user) store.users.markAgeVerified(req.user.id, 'self-declared');
  res.json({ ok: true, expiresAt });
});

router.post('/age/decline', (req, res) => {
  res.clearCookie(auth.AGE_COOKIE, { path: '/' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Boards
// ---------------------------------------------------------------------------

router.get('/boards', (req, res) => {
  const list = boardCache.wrap('all', () =>
    store.boards.all().map((b) => ({
      id: b.id,
      slug: b.slug,
      name: b.name,
      tagline: b.tagline,
      kind: b.kind,
      accent: b.accent,
      icon: b.icon,
      nsfw: !!b.nsfw,
      official: !!b.official,
      memberCount: b.member_count,
      postCount: b.post_count,
    }))
  );
  const subs = req.user ? new Set(store.boards.subscribedIds(req.user.id)) : new Set();
  res.json({ boards: list.map((b) => ({ ...b, subscribed: subs.has(b.id) })) });
});

router.get('/boards/:slug', requireAge, (req, res) => {
  const b = store.boards.bySlug(req.params.slug);
  if (!b) return fail(res, 404, 'No such board.');
  // Rules moved from a JSON blob to rows with citation counts. Seeded boards
  // still carry the old column, so fall back rather than showing them nothing.
  let rules = store.boardRules.list(b.id);
  if (!rules.length) {
    try {
      rules = JSON.parse(b.rules).map((title, i) => ({ id: null, position: i + 1, title, detail: '', cited_count: 0 }));
    } catch { rules = []; }
  }
  res.json({
    board: {
      id: b.id,
      slug: b.slug,
      name: b.name,
      tagline: b.tagline,
      description: b.description,
      kind: b.kind,
      accent: b.accent,
      icon: b.icon,
      nsfw: !!b.nsfw,
      official: !!b.official,
      owner: b.created_by ? (store.users.byId(b.created_by)?.username || null) : null,
      rules,
      moderators: store.boardMods.list(b.id),
      canModerate: canModerate(req, b),
      canConfigure: canConfigure(req, b),
      memberCount: b.member_count,
      postCount: b.post_count,
      createdAt: b.created_at,
      subscribed: req.user ? store.boards.subscribedIds(req.user.id).includes(b.id) : false,
    },
    pinned: decorate(req, store.posts.pinnedFor(b.id)),
  });
});

/**
 * Fan a new comment out to the people it concerns: the parent's author, the
 * thread's author, and anyone named with @.
 *
 * Deduplicated, because replying to the OP inside their own thread is one
 * event, not two, and an inbox that says the same thing twice is an inbox
 * people stop opening. Self-notifications are dropped inside social.js.
 */
const MENTION_RE = /(?:^|[^\w/])@([a-zA-Z0-9][a-zA-Z0-9_-]{2,19})\b/g;

function notifyAboutComment({ commentId, postId, post, parentId, actor, body }) {
  const sent = new Set([actor.id]);
  const excerpt = body.replace(/\s+/g, ' ').slice(0, 140);

  const notify = (userId, kind, title) => {
    if (!userId || sent.has(userId)) return;
    sent.add(userId);
    social.notifications.add({ userId, kind, actorId: actor.id, postId, commentId, title, body: excerpt });
  };

  // A reply to a comment goes to that comment's author first — it is the most
  // specific relationship, and whoever gets it should not also get the
  // less-specific "someone commented on your post".
  if (parentId) {
    const parent = store.comments.get(parentId);
    notify(parent?.author_id, 'comment_reply', `${actor.username} replied to your comment`);
  }

  const opId = post.author && post.author !== '[deleted]'
    ? store.users.byUsername(post.author)?.id
    : null;
  notify(opId, 'reply', `${actor.username} commented on “${post.title.slice(0, 60)}”`);

  for (const match of body.matchAll(MENTION_RE)) {
    const mentioned = store.users.byUsername(match[1]);
    notify(mentioned?.id, 'mention', `${actor.username} mentioned you`);
  }
}

// ---------------------------------------------------------------------------
// Inbox — notifications and direct messages
// ---------------------------------------------------------------------------

router.get('/inbox', requireAge, auth.requireUser, (req, res) => {
  const filter = ['all', 'unread', 'replies', 'mentions'].includes(req.query.filter) ? req.query.filter : 'all';
  res.json({
    filter,
    notifications: social.notifications.list(req.user.id, { filter }),
    unread: social.notifications.unreadCount(req.user.id),
    messagesUnread: social.messages.unreadCount(req.user.id),
  });
});

router.post('/inbox/read', requireAge, auth.requireUser, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((n) => asInt(n)).filter(Boolean) : null;
  const changed = social.notifications.markRead(req.user.id, ids);
  res.json({ ok: true, changed, unread: social.notifications.unreadCount(req.user.id) });
});

router.get('/messages', requireAge, auth.requireUser, (req, res) => {
  res.json({ conversations: social.messages.inbox(req.user.id) });
});

router.get('/messages/:id', requireAge, auth.requireUser, (req, res) => {
  const thread = social.messages.thread(req.user.id, asInt(req.params.id));
  if (!thread) return fail(res, 404, 'No such conversation.');
  res.json(thread);
});

router.post('/messages', requireAge, auth.requireUser, rateLimit('comment', userKey), (req, res) => {
  const to = store.users.byUsername(mod.clean(req.body?.to, 32));
  const body = mod.clean(req.body?.body, 4000);
  if (!to) return fail(res, 404, 'No such user.');
  if (to.id === req.user.id) return fail(res, 400, 'You cannot message yourself.');
  if (body.length < 1) return fail(res, 400, 'Write something.');

  // A block stops the blocked party sending, which is the only direction that
  // matters — the blocker can still read what they said publicly.
  if (social.blocks.has(to.id, req.user.id)) return fail(res, 403, 'That user is not accepting messages from you.');

  const verdict = mod.screen(body);
  if (!verdict.ok) return fail(res, 422, verdict.reason);

  const { conversationId } = social.messages.send({ fromId: req.user.id, toId: to.id, body });
  social.notifications.add({
    userId: to.id, kind: 'message', actorId: req.user.id,
    title: `Message from ${req.user.username}`, body: body.slice(0, 140),
  });
  res.status(201).json({ ok: true, conversationId });
});

// ---------------------------------------------------------------------------
// Awards
// ---------------------------------------------------------------------------

router.get('/awards', requireAge, (req, res) => {
  res.json({
    catalogue: social.awards.CATALOGUE,
    remaining: req.user ? social.awards.remaining(req.user.id) : 0,
  });
});

router.post('/awards', requireAge, auth.requireUser, rateLimit('vote', userKey), (req, res) => {
  const targetType = req.body?.targetType === 'comment' ? 'comment' : 'post';
  const targetId = asInt(req.body?.targetId);
  const award = String(req.body?.award || '');

  const target = targetType === 'post' ? store.posts.get(targetId) : store.comments.get(targetId);
  if (!target) return fail(res, 404, 'That is gone.');

  const result = social.awards.give({
    giverId: req.user.id, targetType, targetId, award,
    note: mod.clean(req.body?.note, 200),
  });
  if (!result.ok) return fail(res, 400, result.error);

  const authorId = targetType === 'post'
    ? store.users.byUsername(target.author)?.id
    : store.comments.get(targetId)?.author_id;
  if (authorId) {
    social.notifications.add({
      userId: authorId, kind: 'award', actorId: req.user.id,
      postId: targetType === 'post' ? targetId : null,
      commentId: targetType === 'comment' ? targetId : null,
      title: `${req.user.username} gave your ${targetType} an award`,
    });
  }

  feedCache.clear();
  postCache.clear();
  res.json(result);
});

// ---------------------------------------------------------------------------
// Custom feeds
// ---------------------------------------------------------------------------

const FEED_SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,22}[a-z0-9]$/;

router.get('/feeds', requireAge, auth.requireUser, (req, res) => {
  res.json({ feeds: social.customFeeds.list(req.user.id) });
});

router.post('/feeds', requireAge, auth.requireUser, (req, res) => {
  const name = mod.clean(req.body?.name, 40);
  const slug = String(req.body?.slug || name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (name.length < 2) return fail(res, 400, 'Give the feed a name.');
  if (!FEED_SLUG_RE.test(slug)) return fail(res, 400, 'That name will not make a usable address.');
  if (social.customFeeds.bySlug(req.user.id, slug)) return fail(res, 409, 'You already have a feed with that name.');

  const boardIds = (Array.isArray(req.body?.boards) ? req.body.boards : [])
    .map((s) => store.boards.bySlug(String(s))?.id).filter(Boolean).slice(0, 40);

  const id = social.customFeeds.create(req.user.id, { slug, name, boardIds });
  res.status(201).json({ id, slug });
});

router.put('/feeds/:slug', requireAge, auth.requireUser, (req, res) => {
  const feed = social.customFeeds.bySlug(req.user.id, req.params.slug);
  if (!feed) return fail(res, 404, 'No such feed.');
  const boardIds = (Array.isArray(req.body?.boards) ? req.body.boards : [])
    .map((s) => store.boards.bySlug(String(s))?.id).filter(Boolean).slice(0, 40);
  social.customFeeds.setBoards(req.user.id, feed.slug, boardIds);
  res.json({ ok: true, count: boardIds.length });
});

router.delete('/feeds/:slug', requireAge, auth.requireUser, (req, res) => {
  if (!social.customFeeds.remove(req.user.id, req.params.slug)) return fail(res, 404, 'No such feed.');
  res.json({ ok: true });
});

/** The feed itself: the same keyset pagination, restricted to the set. */
router.get('/feeds/:slug/posts', requireAge, auth.requireUser, (req, res) => {
  const feed = social.customFeeds.bySlug(req.user.id, req.params.slug);
  if (!feed) return fail(res, 404, 'No such feed.');
  if (!feed.boardIds.length) return res.json({ items: [], nextCursor: null, feed });

  const result = store.posts.feed({
    sort: SORTS.has(req.query.sort) ? req.query.sort : 'hot',
    boardIds: feed.boardIds,
    window: store.TIME_WINDOWS[req.query.t] !== undefined ? req.query.t : 'all',
    cursor: req.query.cursor ? String(req.query.cursor) : null,
    limit: 25,
  });
  const items = result.items.map((p) => ({ ...p }));
  decorate(req, items);
  res.json({ items, nextCursor: result.nextCursor, feed });
});

// ---------------------------------------------------------------------------
// Settings and blocking
// ---------------------------------------------------------------------------

router.get('/settings', requireAge, auth.requireUser, (req, res) => {
  res.json({
    prefs: social.prefs.get(req.user.id),
    blocked: social.blocks.list(req.user.id),
    profile: store.users.publicProfile(req.user.username),
    awardsGiven: 5 - social.awards.remaining(req.user.id),
    awardsRemaining: social.awards.remaining(req.user.id),
    awardsReceived: social.awards.receivedBy(req.user.id),
  });
});

router.patch('/settings', requireAge, auth.requireUser, (req, res) => {
  if (typeof req.body?.bio === 'string') {
    const bio = mod.clean(req.body.bio, 300);
    const verdict = mod.screen(bio);
    if (!verdict.ok) return fail(res, 422, verdict.reason);
    store.users.updateBio(req.user.id, bio);
  }
  const prefs = social.prefs.set(req.user.id, req.body?.prefs || {});
  res.json({ ok: true, prefs });
});

router.post('/settings/password', requireAge, auth.requireUser, rateLimit('login', ipKey), (req, res) => {
  const current = String(req.body?.current ?? '');
  const next = String(req.body?.next ?? '');
  const row = store.users.byId(req.user.id);
  if (!auth.verifyPassword(current, row.password_hash)) return fail(res, 403, 'Current password is wrong.');
  if (next.length < 10) return fail(res, 400, 'Use a password of at least 10 characters.');
  if (next.length > 200) return fail(res, 400, 'That password is too long.');

  store.users.setPassword(req.user.id, auth.hashPassword(next));
  // Every other session dies: changing a password is what you do when you think
  // somebody else has one.
  auth.dropOtherSessions(req.user.id, req.cookies?.[auth.SESSION_COOKIE]);
  res.json({ ok: true });
});

router.post('/block/:username', requireAge, auth.requireUser, (req, res) => {
  const target = store.users.byUsername(req.params.username);
  if (!target) return fail(res, 404, 'No such user.');
  if (target.id === req.user.id) return fail(res, 400, 'You cannot block yourself.');
  social.blocks.add(req.user.id, target.id);
  feedCache.clear();
  res.json({ blocked: true });
});

router.delete('/block/:username', requireAge, auth.requireUser, (req, res) => {
  const target = store.users.byUsername(req.params.username);
  if (!target) return fail(res, 404, 'No such user.');
  social.blocks.remove(req.user.id, target.id);
  feedCache.clear();
  res.json({ blocked: false });
});

// ---------------------------------------------------------------------------
// Communities
//
// Anyone can found one. What makes it more than a folder is the rule system:
// rules are numbered rows, every moderator removal must cite one, and the
// citation counts are public — so a community can see which of its rules are
// load-bearing and which are decoration, and whether enforcement is drifting.
// ---------------------------------------------------------------------------

// A slug is a permanent URL and a thing people type aloud. Tight on purpose.
const SLUG_RE = /^[a-z0-9](?:[a-z0-9_-]{1,22}[a-z0-9])$/;
const RESERVED_SLUGS = new Set([
  'new', 'all', 'submit', 'search', 'saved', 'mod', 'admin', 'api', 'settings',
  'about', 'help', 'login', 'logout', 'register', 'me', 'u', 'p', 'b', 't', 'c', 'ads', 'i',
]);

const communityRole = (req, board) => {
  if (!req.user) return null;
  if (req.user.role === 'admin') return 'admin';
  return store.boardMods.roleOf(board.id, req.user.id);
};
const canModerate = (req, board) => !!communityRole(req, board);
const canConfigure = (req, board) => ['owner', 'admin'].includes(communityRole(req, board));

router.get('/communities', requireAge, (req, res) => {
  const sort = ['active', 'new', 'members'].includes(req.query.sort) ? req.query.sort : 'active';
  const list = boardCache.wrap(`disc|${sort}`, () => store.boards.discover({ sort, limit: 60 }), 20000);
  const subs = req.user ? new Set(store.boards.subscribedIds(req.user.id)) : new Set();
  res.json({
    sort,
    communities: list.map((b) => ({
      slug: b.slug, name: b.name, tagline: b.tagline, accent: b.accent, kind: b.kind,
      nsfw: !!b.nsfw, official: !!b.official, owner: b.owner || null,
      memberCount: b.member_count, postCount: b.post_count,
      recentPosts: b.recent_posts, createdAt: b.created_at,
      subscribed: subs.has(b.id),
    })),
  });
});

router.post('/communities', requireAge, auth.requireUser, rateLimit('post', userKey), (req, res) => {
  const slug = String(req.body?.slug || '').trim().toLowerCase();
  const name = mod.clean(req.body?.name, 60);
  const tagline = mod.clean(req.body?.tagline, 140);
  const description = mod.clean(req.body?.description, 2000);
  const accent = /^#[0-9a-f]{6}$/i.test(String(req.body?.accent || '')) ? req.body.accent : '#d4ff3d';

  if (!SLUG_RE.test(slug)) {
    return fail(res, 400, 'Names are 3–24 characters: lowercase letters, numbers, hyphen or underscore, starting and ending with a letter or number.');
  }
  if (RESERVED_SLUGS.has(slug)) return fail(res, 400, 'That name is reserved by the site.');
  if (store.boards.slugTaken(slug)) return fail(res, 409, 'Taken. Pick another.');
  if (name.length < 3) return fail(res, 400, 'Give it a display name.');

  const verdict = mod.screen(name, `${tagline}\n${description}`, slug);
  if (!verdict.ok) return fail(res, 422, verdict.reason);

  // Rules arrive with the community: founding without any is how a place ends
  // up moderated by vibes, and the whole point here is that removals cite one.
  const rules = (Array.isArray(req.body?.rules) ? req.body.rules : [])
    .slice(0, 12)
    .map((r) => ({ title: mod.clean(r?.title, 90), detail: mod.clean(r?.detail, 400) }))
    .filter((r) => r.title.length >= 3);

  if (!rules.length) return fail(res, 400, 'Write at least one rule — removals have to cite one.');

  const id = store.boards.createCommunity({
    slug, name, tagline, description, accent,
    ownerId: req.user.id,
    nsfw: req.body?.nsfw === true || req.body?.nsfw === 'true',
    rules,
  });

  boardCache.clear();
  feedCache.clear();
  res.status(201).json({ id, slug });
});

router.patch('/communities/:slug', requireAge, auth.requireUser, (req, res) => {
  const board = store.boards.bySlug(req.params.slug);
  if (!board) return fail(res, 404, 'No such community.');
  if (!canConfigure(req, board)) return fail(res, 403, 'Only the owner can change this.');
  if (board.official) return fail(res, 403, 'Site boards are configured in the seed, not here.');

  const name = mod.clean(req.body?.name, 60) || board.name;
  const tagline = mod.clean(req.body?.tagline, 140);
  const description = mod.clean(req.body?.description, 2000);
  const accent = /^#[0-9a-f]{6}$/i.test(String(req.body?.accent || '')) ? req.body.accent : board.accent;

  const verdict = mod.screen(name, `${tagline}\n${description}`);
  if (!verdict.ok) return fail(res, 422, verdict.reason);

  store.boards.updateCommunity(board.id, {
    name, tagline, description, accent,
    nsfw: req.body?.nsfw === true || req.body?.nsfw === 'true',
  });
  boardCache.clear();
  feedCache.clear();
  res.json({ ok: true });
});

/** Rules, their citation counts, and who enforces them. Public by design. */
router.get('/communities/:slug/rules', requireAge, (req, res) => {
  const board = store.boards.bySlug(req.params.slug);
  if (!board) return fail(res, 404, 'No such community.');
  res.json({
    rules: store.boardRules.list(board.id),
    moderators: store.boardMods.list(board.id),
    canConfigure: canConfigure(req, board),
    canModerate: canModerate(req, board),
  });
});

router.get('/communities/:slug/rules/:id', requireAge, (req, res) => {
  const board = store.boards.bySlug(req.params.slug);
  if (!board) return fail(res, 404, 'No such community.');
  const rule = store.boardRules.get(asInt(req.params.id));
  if (!rule || rule.board_id !== board.id) return fail(res, 404, 'No such rule.');
  res.json({ rule, enforcement: store.boardRules.enforcementLog(rule.id, 25) });
});

router.post('/communities/:slug/rules', requireAge, auth.requireUser, (req, res) => {
  const board = store.boards.bySlug(req.params.slug);
  if (!board) return fail(res, 404, 'No such community.');
  if (!canConfigure(req, board)) return fail(res, 403, 'Only the owner can change the rules.');

  const title = mod.clean(req.body?.title, 90);
  const detail = mod.clean(req.body?.detail, 400);
  if (title.length < 3) return fail(res, 400, 'A rule needs a title.');
  if (store.boardRules.list(board.id).length >= 12) return fail(res, 400, 'Twelve rules is the ceiling. Nobody reads thirteen.');

  const id = store.boardRules.add(board.id, { title, detail });
  boardCache.clear();
  res.status(201).json({ id });
});

router.delete('/communities/:slug/rules/:id', requireAge, auth.requireUser, (req, res) => {
  const board = store.boards.bySlug(req.params.slug);
  if (!board) return fail(res, 404, 'No such community.');
  if (!canConfigure(req, board)) return fail(res, 403, 'Only the owner can change the rules.');
  const rule = store.boardRules.get(asInt(req.params.id));
  if (!rule || rule.board_id !== board.id) return fail(res, 404, 'No such rule.');

  // Retired, never deleted: past removals cite this, and a moderation record
  // pointing at a rule that no longer exists is worse than no record.
  store.boardRules.retire(rule.id);
  boardCache.clear();
  res.json({ ok: true, retired: true });
});

router.post('/communities/:slug/mods', requireAge, auth.requireUser, (req, res) => {
  const board = store.boards.bySlug(req.params.slug);
  if (!board) return fail(res, 404, 'No such community.');
  if (!canConfigure(req, board)) return fail(res, 403, 'Only the owner can appoint moderators.');

  const target = store.users.byUsername(mod.clean(req.body?.username, 32));
  if (!target) return fail(res, 404, 'No such user.');
  store.boardMods.add(board.id, target.id, req.user.id);
  res.json({ moderators: store.boardMods.list(board.id) });
});

router.delete('/communities/:slug/mods/:username', requireAge, auth.requireUser, (req, res) => {
  const board = store.boards.bySlug(req.params.slug);
  if (!board) return fail(res, 404, 'No such community.');
  if (!canConfigure(req, board)) return fail(res, 403, 'Only the owner can remove moderators.');
  const target = store.users.byUsername(req.params.username);
  if (!target) return fail(res, 404, 'No such user.');
  if (!store.boardMods.remove(board.id, target.id)) {
    return fail(res, 400, 'The owner cannot be removed.');
  }
  res.json({ moderators: store.boardMods.list(board.id) });
});

/**
 * Community-level moderation. Unlike the site-wide queue this is scoped to one
 * board and *requires* a rule id — the removal is recorded against that rule,
 * the counter moves, and the enforcement shows up in the public log.
 */
router.post('/communities/:slug/moderate', requireAge, auth.requireUser, (req, res) => {
  const board = store.boards.bySlug(req.params.slug);
  if (!board) return fail(res, 404, 'No such community.');
  if (!canModerate(req, board)) return fail(res, 403, 'You do not moderate this community.');

  const action = String(req.body?.action || '');
  const targetType = req.body?.targetType === 'comment' ? 'comment' : 'post';
  const targetId = asInt(req.body?.targetId);
  const note = mod.clean(req.body?.note, 300);
  const ruleId = asInt(req.body?.ruleId);

  const post = targetType === 'post' ? store.posts.get(targetId) : null;
  if (targetType === 'post' && (!post || post.boardId !== board.id)) {
    return fail(res, 404, 'That post is not in this community.');
  }

  let rule = null;
  if (action === 'remove') {
    rule = store.boardRules.get(ruleId);
    if (!rule || rule.board_id !== board.id || rule.retired_at) {
      return fail(res, 400, 'Removals must cite one of this community\'s rules.');
    }
  }

  const reason = rule ? `Rule ${rule.position}: ${rule.title}${note ? ` — ${note}` : ''}` : note;

  switch (action) {
    case 'remove':
    case 'restore':
      if (targetType === 'post') store.posts.setRemoved(targetId, action === 'remove', req.user.id, reason);
      else store.comments.setRemoved(targetId, action === 'remove', req.user.id, reason);
      break;
    case 'lock':
    case 'unlock':
      store.posts.setLocked(targetId, action === 'lock');
      break;
    case 'pin':
    case 'unpin':
      store.posts.setPinned(targetId, action === 'pin');
      break;
    default:
      return fail(res, 400, 'Unknown action.');
  }

  store.modLog.add({
    actorId: req.user.id, action, targetType, targetId, reason,
    boardId: board.id, ruleId: rule ? rule.id : null,
  });

  // The author hears about it, and hears which rule — a removal you cannot
  // trace to a rule is indistinguishable from one that never happened.
  if (action === 'remove') {
    const authorId = targetType === 'post'
      ? store.users.byUsername(post?.author)?.id
      : store.comments.get(targetId)?.author_id;
    social.notifications.add({
      userId: authorId, kind: 'mod', actorId: req.user.id,
      postId: targetType === 'post' ? targetId : null,
      commentId: targetType === 'comment' ? targetId : null,
      title: `Removed from ${board.name}`, body: reason,
    });
  }
  feedCache.clear();
  postCache.clear();
  boardCache.clear();
  res.json({ ok: true, citedRule: rule ? { id: rule.id, position: rule.position, title: rule.title } : null });
});

router.post('/boards/:slug/subscribe', auth.requireUser, (req, res) => {
  const b = store.boards.bySlug(req.params.slug);
  if (!b) return fail(res, 404, 'No such board.');
  const subscribed = store.boards.subscribe(req.user.id, b.id);
  boardCache.clear();
  res.json({ subscribed });
});

// ---------------------------------------------------------------------------
// Feeds
// ---------------------------------------------------------------------------

const SORTS = new Set(['hot', 'new', 'top', 'rising', 'views', 'published']);

router.get('/feed', requireAge, (req, res) => {
  const sort = SORTS.has(req.query.sort) ? req.query.sort : 'hot';
  const window = store.TIME_WINDOWS[req.query.t] !== undefined ? req.query.t : 'all';
  const limit = Math.min(Math.max(asInt(req.query.limit, 25), 1), 50);
  const cursor = req.query.cursor ? String(req.query.cursor) : null;
  const scope = req.query.scope === 'subscribed' && req.user ? 'subscribed' : 'all';

  let boardId = null;
  let boardIds = null;
  if (req.query.board) {
    const b = store.boards.bySlug(req.query.board);
    if (!b) return fail(res, 404, 'No such board.');
    boardId = b.id;
  } else if (scope === 'subscribed') {
    boardIds = store.boards.subscribedIds(req.user.id);
    if (!boardIds.length) return res.json({ items: [], nextCursor: null, empty: 'no-subscriptions' });
  }

  // Subscribed feeds are per-user, so they skip the shared cache.
  const cacheKey = scope === 'subscribed'
    ? null
    : `f|${sort}|${boardId || '-'}|${window}|${limit}|${cursor || '-'}`;

  const result = cacheKey
    ? feedCache.wrap(cacheKey, () => store.posts.feed({ sort, boardId, window, cursor, limit }))
    : store.posts.feed({ sort, boardIds, window, cursor, limit });

  // Clone so per-viewer vote state never leaks into the shared cache entry.
  const items = result.items.map((p) => ({ ...p }));
  decorate(req, items);
  res.json({ items, nextCursor: result.nextCursor, sort, window, scope });
});

/**
 * What is alive right now — ranked by *recent comment activity*, not score.
 * A 400-point thread nobody is replying to is finished reading; a 40-point
 * thread with 30 fresh replies is where the conversation is.
 */
router.get('/trending', requireAge, (req, res) => {
  const items = feedCache.wrap('trending', () => store.posts.trending(86400e3, 6), 60000);
  res.json({ items });
});

/**
 * How many posts have landed since the reader loaded the page. Counting is far
 * cheaper than re-running the feed, so the client can poll this on a timer and
 * offer a "N new posts" pill rather than silently going stale.
 */
router.get('/feed/updates', requireAge, (req, res) => {
  const since = asInt(req.query.since, 0);
  if (!since) return res.json({ count: 0 });
  let boardId = null;
  if (req.query.board) {
    const b = store.boards.bySlug(req.query.board);
    if (!b) return fail(res, 404, 'No such board.');
    boardId = b.id;
  }
  const key = `u|${since}|${boardId || '-'}`;
  res.json({ count: statsCache.wrap(key, () => store.posts.newerThan(since, boardId), 8000) });
});

/**
 * Ad slot geometry. The client needs the declared sizes to reserve each box
 * before anything loads; the tags themselves never touch this response.
 */
router.get('/ads', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ ads: ads.config() });
});

/**
 * The directory. Public read; only staff can add, because a link list on an
 * adult site is exactly the surface spammers want and an unmoderated one stops
 * being a directory within a week.
 */
router.get('/sites', requireAge, (req, res) => {
  res.set('Cache-Control', 'private, max-age=60');
  res.json({ categories: sites.all() });
});

router.post('/sites/:id/click', requireAge, (req, res) => {
  sites.click(asInt(req.params.id));
  res.json({ ok: true });
});

router.post('/sites', requireAge, auth.requireUser, (req, res) => {
  if (!isStaff(req)) return fail(res, 403, 'Staff only.');
  const name = mod.clean(req.body?.name, 60);
  const url = mod.cleanUrl(req.body?.url);
  const category = String(req.body?.category || '');
  const blurb = mod.clean(req.body?.blurb, 200);
  if (!name || !url) return fail(res, 400, 'Name and a valid http(s) URL are required.');
  if (!sites.CATEGORY_KEYS.has(category)) return fail(res, 400, 'Unknown category.');
  const verdict = mod.screen(name, blurb, url);
  if (!verdict.ok) return fail(res, 422, verdict.reason);
  const id = sites.add({ name, url, category, blurb, userId: req.user.id });
  res.status(201).json({ id });
});

/** What the site is talking about, derived from the wire rather than curated. */
router.get('/topics', requireAge, (req, res) => {
  res.json({ items: feedCache.wrap('topics', () => topics.trending({ limit: 14 }), 60000) });
});

router.get('/topics/:slug', requireAge, (req, res) => {
  const topic = topics.bySlug(req.params.slug);
  if (!topic) return fail(res, 404, 'No such topic.');
  const cursor = req.query.cursor ? String(req.query.cursor) : null;
  const result = store.posts.byTopic(topic.slug, 25, cursor);
  const items = result.items.map((p) => ({ ...p }));
  decorate(req, items);
  res.json({ topic, items, nextCursor: result.nextCursor });
});

/**
 * Reactions. Deliberately separate from voting: the vote moves the post up the
 * page, the reaction says something about it. Most readers will never write a
 * comment, and this is the contribution they will actually make.
 */
router.post('/react', requireAge, auth.requireUser, rateLimit('vote', userKey), (req, res) => {
  const type = req.body?.type === 'comment' ? 'comment' : 'post';
  const id = asInt(req.body?.id);
  const emoji = String(req.body?.emoji || '');

  if (!store.reactions.EMOJI.includes(emoji)) return fail(res, 400, 'Not one of the available reactions.');
  const exists = type === 'post' ? store.posts.get(id) : store.comments.get(id);
  if (!exists) return fail(res, 404, 'That is gone.');

  const result = store.reactions.toggle(req.user.id, type, id, emoji);
  feedCache.clear();
  postCache.clear();
  res.json(result);
});

router.get('/saved', requireAge, auth.requireUser, (req, res) => {
  const items = store.saves.forUser(req.user.id, 50);
  decorate(req, items);
  res.json({ items });
});

router.post('/posts/:id/save', requireAge, auth.requireUser, (req, res) => {
  const id = asInt(req.params.id);
  if (!store.posts.get(id)) return fail(res, 404, 'That post is gone.');
  const saved = store.saves.toggle(req.user.id, id);
  res.json({ saved });
});

/** Username prefix search, for the People tab. */
router.get('/users/search', requireAge, (req, res) => {
  const q = mod.clean(req.query.q, 32);
  if (q.length < 2) return res.json({ users: [] });
  const rows = db.prepare(
    `SELECT username, post_karma, comment_karma, created_at FROM users
      WHERE username LIKE ? ESCAPE '\\' AND banned_until < ?
      ORDER BY (post_karma + comment_karma) DESC LIMIT 25`
  // LIKE treats % and _ as wildcards, so a search for "a_b" must not become a
  // pattern. Escaping them (and the escape character itself) keeps it literal.
  ).all(`%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`, Date.now());
  res.json({
    users: rows.map((u) => ({
      username: u.username, postKarma: u.post_karma,
      commentKarma: u.comment_karma, createdAt: u.created_at,
    })),
  });
});

router.get('/search', requireAge, (req, res) => {
  const q = mod.clean(req.query.q, 120);
  if (q.length < 2) return res.json({ items: [], query: q });
  const items = feedCache.wrap(`s|${q.toLowerCase()}`, () => store.posts.search(q, 30), 15000)
    .map((p) => ({ ...p }));
  decorate(req, items);
  res.json({ items, query: q });
});

// ---------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------

router.post('/posts', requireAge, auth.requireUser, rateLimit('post', userKey), (req, res) => {
  const board = store.boards.bySlug(req.body?.board);
  if (!board) return fail(res, 404, 'Pick a board that exists.');
  if (board.kind === 'news' && !isStaff(req)) {
    return fail(res, 403, 'The newsroom is staff-published. Post industry links in r/industry instead.');
  }

  const title = mod.clean(req.body?.title, 300);
  const body = mod.clean(req.body?.body, 20000);
  const flair = mod.clean(req.body?.flair, 32);
  const kind = req.body?.kind === 'link' ? 'link' : 'text';

  if (title.length < 5) return fail(res, 400, 'Give it a title of at least 5 characters.');
  if (kind === 'text' && body.length < 1) return fail(res, 400, 'Write something in the body.');

  let url = '';
  if (kind === 'link') {
    url = mod.cleanUrl(req.body?.url);
    if (!url) return fail(res, 400, 'That link is not a valid http(s) URL.');
  }

  const verdict = mod.screen(title, body, url);
  if (!verdict.ok) {
    store.modLog.add({
      actorId: req.user.id,
      action: 'auto_block',
      targetType: 'submission',
      targetId: 0,
      reason: 'hard_block filter',
    });
    return fail(res, 422, verdict.reason);
  }

  // URL parsing is free, so a YouTube link gets its poster before the response
  // is even written. The full OG fetch happens in the background pass.
  const video = kind === 'link' ? parseVideo(url) : null;

  const id = store.posts.create({
    boardId: board.id,
    authorId: req.user.id,
    kind,
    title,
    body,
    url,
    flair,
    imageUrl: video?.poster || '',
    videoKind: video?.kind || '',
    videoId: video?.id || '',
    // A board that is explicit by nature marks its posts so, and the poster can
    // mark anything else. Once set it cannot be unset by editing.
    nsfw: !!board.nsfw || req.body?.nsfw === true || req.body?.nsfw === 'true',
  });

  topics.attach(id, { title });

  // Fire-and-forget: never make the poster wait on a publisher's server.
  if (kind === 'link' && !video) {
    setImmediate(() => {
      enrichPending({ limit: 3 }).catch(() => {});
    });
  }

  if (verdict.flags.length) {
    store.reports.create({
      reporterId: null,
      targetType: 'post',
      targetId: id,
      reason: 'auto-flag',
      detail: verdict.flags.join(', '),
    });
  }

  feedCache.clear();
  boardCache.clear();
  res.status(201).json({ id, board: board.slug });
});

router.get('/posts/:id', requireAge, (req, res) => {
  const id = asInt(req.params.id);
  const post = postCache.wrap(`p${id}`, () => store.posts.get(id));
  if (!post) return fail(res, 404, 'That post is gone.');

  const sort = ['best', 'top', 'new', 'old', 'controversial'].includes(req.query.sort) ? req.query.sort : 'best';
  const tree = store.comments.tree(id, sort);

  const copy = { ...post };
  decorate(req, [copy]);
  copy.canEdit = canEdit(req, copy.author);

  if (req.user) {
    const ids = [];
    const collect = (nodes) => {
      for (const n of nodes) {
        ids.push(n.id);
        if (n.replies.length) collect(n.replies);
      }
    };
    collect(tree.roots);
    const map = store.votes.forTargets(req.user.id, 'comment', ids);
    const apply = (nodes) => {
      for (const n of nodes) {
        n.myVote = map[n.id] || 0;
        n.canEdit = canEdit(req, n.author);
        if (n.replies.length) apply(n.replies);
      }
    };
    apply(tree.roots);
  }

  // "More from this board" — the cheapest thing that turns one read into two.
  const related = decorate(req, store.posts.related(id, post.boardId, 4));

  const boardRow = store.boards.bySlug(post.board.slug);
  res.json({
    post: copy,
    comments: tree.roots,
    commentTotal: tree.total,
    commentSort: sort,
    truncated: tree.truncated,
    related,
    // Reddit shows the community beside the post being read, which is the
    // moment somebody is most likely to join it.
    community: boardRow ? {
      slug: boardRow.slug,
      name: boardRow.name,
      tagline: boardRow.tagline,
      accent: boardRow.accent,
      nsfw: !!boardRow.nsfw,
      memberCount: boardRow.member_count,
      postCount: boardRow.post_count,
      createdAt: boardRow.created_at,
      subscribed: req.user ? store.boards.subscribedIds(req.user.id).includes(boardRow.id) : false,
      rules: store.boardRules.list(boardRow.id).slice(0, 5),
      moderators: store.boardMods.list(boardRow.id),
    } : null,
  });
});

// ---------------------------------------------------------------------------
// Wire sources — operator visibility
//
// Which publishers are actually reachable depends entirely on where this is
// deployed: a network that filters adult domains will silently starve half the
// registry. Rather than let that look like "the site has no news", the health
// of every source is inspectable.
// ---------------------------------------------------------------------------

router.get('/sources', requireAge, (req, res) => {
  const staff = isStaff(req);
  const list = sources.all().map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    board: s.board,
    nsfw: s.nsfw,
    enabled: s.enabled,
    lastOkAt: s.lastOkAt,
    lastStatus: s.lastStatus,
    itemsAdded: s.itemsAdded,
    // A URL or an error string can leak internal detail; keep them for staff.
    ...(staff ? { url: s.url, adapter: s.adapter, lastError: s.lastError, builtin: s.builtin, note: s.note } : {}),
  }));
  res.json({ sources: list });
});

router.post('/sources/:id/enabled', auth.requireUser, (req, res) => {
  if (!isStaff(req)) return fail(res, 403, 'Staff only.');
  const on = req.body?.enabled === true || req.body?.enabled === 'true';
  if (!sources.setEnabled(req.params.id, on)) return fail(res, 404, 'No such source.');
  res.json({ id: req.params.id, enabled: on });
});

/** Run the wire on demand rather than waiting for the twenty-minute timer. */
router.post('/sources/run', auth.requireUser, rateLimit('post', userKey), wrap(async (req, res) => {
  if (!isStaff(req)) return fail(res, 403, 'Staff only.');
  const only = req.body?.id ? String(req.body.id) : null;
  const summary = await ingest({ only });
  feedCache.clear();
  boardCache.clear();
  setImmediate(() => { enrichPending({ limit: 10 }).catch(() => {}); });
  res.json(summary);
}));

router.patch('/posts/:id', requireAge, auth.requireUser, (req, res) => {
  const post = store.posts.get(asInt(req.params.id));
  if (!post) return fail(res, 404, 'That post is gone.');
  if (!canEdit(req, post.author)) return fail(res, 403, 'Not your post.');
  if (post.kind !== 'text') return fail(res, 400, 'Only text posts can be edited.');

  const body = mod.clean(req.body?.body, 20000);
  const verdict = mod.screen(post.title, body);
  if (!verdict.ok) return fail(res, 422, verdict.reason);

  store.posts.edit(post.id, body);
  postCache.clear();
  feedCache.clear();
  res.json({ ok: true, body });
});

router.delete('/posts/:id', requireAge, auth.requireUser, (req, res) => {
  const post = store.posts.get(asInt(req.params.id));
  if (!post) return fail(res, 404, 'That post is gone.');
  if (!canEdit(req, post.author)) return fail(res, 403, 'Not your post.');
  store.posts.setRemoved(post.id, true, req.user.id, 'deleted by author');
  store.modLog.add({ actorId: req.user.id, action: 'delete', targetType: 'post', targetId: post.id });
  postCache.clear();
  feedCache.clear();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

router.post('/posts/:id/comments', requireAge, auth.requireUser, rateLimit('comment', userKey), (req, res) => {
  const postId = asInt(req.params.id);
  const post = store.posts.get(postId);
  if (!post || post.removed) return fail(res, 404, 'That post is gone.');
  if (post.locked && !isStaff(req)) return fail(res, 403, 'This thread is locked.');

  const body = mod.clean(req.body?.body, 10000);
  if (body.length < 1) return fail(res, 400, 'Write something first.');

  const verdict = mod.screen(body);
  if (!verdict.ok) {
    store.modLog.add({ actorId: req.user.id, action: 'auto_block', targetType: 'comment', targetId: 0, reason: 'hard_block filter' });
    return fail(res, 422, verdict.reason);
  }

  const parentId = req.body?.parentId ? asInt(req.body.parentId) : null;
  let id;
  try {
    id = store.comments.create({ postId, parentId, authorId: req.user.id, body });
  } catch (err) {
    if (String(err.message) === 'BAD_PARENT') return fail(res, 400, 'That parent comment is not in this thread.');
    throw err;
  }

  if (verdict.flags.length) {
    store.reports.create({ reporterId: null, targetType: 'comment', targetId: id, reason: 'auto-flag', detail: verdict.flags.join(', ') });
  }

  notifyAboutComment({ commentId: id, postId, post, parentId, actor: req.user, body });

  postCache.clear();
  const row = store.comments.get(id);
  res.status(201).json({
    comment: {
      id,
      parentId,
      body,
      depth: row.depth,
      score: 1,
      ups: 1,
      downs: 0,
      replyCount: 0,
      createdAt: row.created_at,
      editedAt: 0,
      removed: false,
      author: req.user.username,
      authorRole: req.user.role,
      authorSeed: req.user.avatarSeed,
      myVote: 1,
      canEdit: true,
      replies: [],
    },
  });
});

router.patch('/comments/:id', requireAge, auth.requireUser, (req, res) => {
  const id = asInt(req.params.id);
  const row = store.comments.get(id);
  if (!row || row.removed) return fail(res, 404, 'That comment is gone.');
  const author = row.author_id ? store.users.byId(row.author_id) : null;
  if (!canEdit(req, author?.username || '')) return fail(res, 403, 'Not your comment.');

  const body = mod.clean(req.body?.body, 10000);
  if (body.length < 1) return fail(res, 400, 'Write something first.');
  const verdict = mod.screen(body);
  if (!verdict.ok) return fail(res, 422, verdict.reason);

  store.comments.edit(id, body);
  postCache.clear();
  res.json({ ok: true, body });
});

router.delete('/comments/:id', requireAge, auth.requireUser, (req, res) => {
  const id = asInt(req.params.id);
  const row = store.comments.get(id);
  if (!row) return fail(res, 404, 'That comment is gone.');
  const author = row.author_id ? store.users.byId(row.author_id) : null;
  if (!canEdit(req, author?.username || '')) return fail(res, 403, 'Not your comment.');
  store.comments.setRemoved(id, true, req.user.id, 'deleted by author');
  postCache.clear();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Voting
// ---------------------------------------------------------------------------

function voteHandler(targetType) {
  return (req, res) => {
    const value = asInt(req.body?.value, 0);
    if (![1, 0, -1].includes(value)) return fail(res, 400, 'Vote must be 1, 0 or -1.');
    try {
      const result = store.votes.cast({
        userId: req.user.id,
        targetType,
        targetId: asInt(req.params.id),
        value,
      });
      if (targetType === 'post') feedCache.clear();
      postCache.clear();
      res.json(result || { unchanged: true, value });
    } catch (err) {
      if (String(err.message) === 'NOT_FOUND') return fail(res, 404, 'Nothing there to vote on.');
      throw err;
    }
  };
}

router.post('/posts/:id/vote', requireAge, auth.requireUser, rateLimit('vote', userKey), voteHandler('post'));
router.post('/comments/:id/vote', requireAge, auth.requireUser, rateLimit('vote', userKey), voteHandler('comment'));

// ---------------------------------------------------------------------------
// Newsroom
// ---------------------------------------------------------------------------

router.get('/news', requireAge, (req, res) => {
  const limit = Math.min(Math.max(asInt(req.query.limit, 20), 1), 50);
  const cursor = req.query.cursor ? String(req.query.cursor) : null;
  const newsBoards = store.boards.all().filter((b) => b.kind === 'news').map((b) => b.id);
  if (!newsBoards.length) return res.json({ items: [], nextCursor: null });

  const key = `news|${limit}|${cursor || '-'}`;
  const result = feedCache.wrap(key, () =>
    store.posts.feed({ sort: 'published', boardIds: newsBoards, cursor, limit })
  );
  const items = result.items.map((p) => ({ ...p }));
  decorate(req, items);
  res.json({ items, nextCursor: result.nextCursor });
});

/** Compact headline strip for the ticker. */
router.get('/news/ticker', (req, res) => {
  const items = feedCache.wrap('ticker', () => {
    const newsBoards = store.boards.all().filter((b) => b.kind === 'news').map((b) => b.id);
    if (!newsBoards.length) return [];
    return store.posts
      .feed({ sort: 'published', boardIds: newsBoards, limit: 12 })
      .items.map((p) => ({ id: p.id, title: p.title, source: p.source, board: p.board.slug, publishedAt: p.publishedAt }));
  }, 20000);
  res.json({ items });
});

router.post('/news/refresh', auth.requireUser, auth.requireStaff, wrap(async (req, res) => {
  const summary = await ingest();
  const media = await enrichPending({ limit: 30 });
  feedCache.clear();
  postCache.clear();
  res.json({ ...summary, media });
}));

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

router.get('/users/:username', requireAge, (req, res) => {
  const profile = store.users.publicProfile(req.params.username);
  if (!profile) return fail(res, 404, 'No such user.');
  const posts = store.posts.byAuthor(profile.username, 20);
  decorate(req, posts.items);
  res.json({
    profile,
    posts: posts.items,
    nextCursor: posts.nextCursor,
    comments: store.comments.byAuthor(profile.username, 20),
  });
});

// ---------------------------------------------------------------------------
// Reports & moderation
// ---------------------------------------------------------------------------

const REPORT_REASONS = [
  'Sexual content involving a minor',
  'Non-consensual content',
  'Doxxing / personal information',
  'Spam or advertising',
  'Harassment',
  'Illegal content',
  'Other',
];

router.get('/report/reasons', (req, res) => res.json({ reasons: REPORT_REASONS }));

router.post('/report', requireAge, auth.requireUser, rateLimit('report', userKey), (req, res) => {
  const targetType = req.body?.targetType === 'comment' ? 'comment' : 'post';
  const targetId = asInt(req.body?.targetId);
  const reason = mod.clean(req.body?.reason, 80);
  const detail = mod.clean(req.body?.detail, 1000);
  if (!targetId) return fail(res, 400, 'Nothing to report.');
  if (!REPORT_REASONS.includes(reason)) return fail(res, 400, 'Pick a listed reason.');

  store.reports.create({ reporterId: req.user.id, targetType, targetId, reason, detail });
  res.status(201).json({ ok: true });
});

router.get('/mod/queue', auth.requireUser, auth.requireStaff, (req, res) => {
  const status = ['open', 'actioned', 'dismissed'].includes(req.query.status) ? req.query.status : 'open';
  const queue = store.reports.queue(status, 100).map((r) => {
    const target = r.target_type === 'post'
      ? store.posts.get(r.target_id)
      : (() => {
        const c = store.comments.get(r.target_id);
        if (!c) return null;
        const author = c.author_id ? store.users.byId(c.author_id) : null;
        return { id: c.id, body: c.body, author: author?.username || '[deleted]', removed: !!c.removed, postId: c.post_id };
      })();
    return { ...r, target };
  });
  res.json({ queue, log: store.modLog.recent(30) });
});

router.post('/mod/action', auth.requireUser, auth.requireStaff, (req, res) => {
  const action = String(req.body?.action || '');
  const targetType = req.body?.targetType === 'comment' ? 'comment' : 'post';
  const targetId = asInt(req.body?.targetId);
  const reason = mod.clean(req.body?.reason, 300);
  const reportId = req.body?.reportId ? asInt(req.body.reportId) : null;

  switch (action) {
    case 'remove':
    case 'restore': {
      const removed = action === 'remove';
      if (targetType === 'post') store.posts.setRemoved(targetId, removed, req.user.id, reason);
      else store.comments.setRemoved(targetId, removed, req.user.id, reason);
      break;
    }
    case 'lock':
    case 'unlock':
      store.posts.setLocked(targetId, action === 'lock');
      break;
    case 'pin':
    case 'unpin':
      store.posts.setPinned(targetId, action === 'pin');
      break;
    default:
      return fail(res, 400, 'Unknown moderator action.');
  }

  store.modLog.add({ actorId: req.user.id, action, targetType, targetId, reason });
  if (reportId) store.reports.resolve(reportId, 'actioned', req.user.id);
  feedCache.clear();
  postCache.clear();
  res.json({ ok: true });
});

router.post('/mod/dismiss', auth.requireUser, auth.requireStaff, (req, res) => {
  const reportId = asInt(req.body?.reportId);
  if (!reportId) return fail(res, 400, 'Which report?');
  store.reports.resolve(reportId, 'dismissed', req.user.id);
  res.json({ ok: true });
});

router.post('/mod/ban', auth.requireUser, auth.requireAdmin, (req, res) => {
  const target = store.users.byUsername(mod.clean(req.body?.username, 20));
  if (!target) return fail(res, 404, 'No such user.');
  if (target.role === 'admin') return fail(res, 403, 'Admins cannot be banned through the API.');
  const days = Math.min(Math.max(asInt(req.body?.days, 7), 0), 3650);
  const reason = mod.clean(req.body?.reason, 300);
  store.users.ban(target.id, days ? Date.now() + days * 86400e3 : 0, reason);
  store.modLog.add({ actorId: req.user.id, action: days ? 'ban' : 'unban', targetType: 'user', targetId: target.id, reason });
  res.json({ ok: true, until: days ? Date.now() + days * 86400e3 : 0 });
});

// ---------------------------------------------------------------------------
// Site stats & health
// ---------------------------------------------------------------------------

router.get('/stats', (req, res) => {
  const stats = statsCache.wrap('site', () => ({
    users: store.users.count(),
    online: store.users.activeSince(Date.now() - 5 * 60000),
    activeToday: store.users.activeSince(Date.now() - 86400e3),
    postsToday: store.posts.countSince(Date.now() - 86400e3),
    commentsToday: store.comments.countSince(Date.now() - 86400e3),
    boards: store.boards.all().length,
  }));
  res.json(stats);
});

router.get('/health', (req, res) => {
  const row = db.prepare('SELECT 1 AS ok').get();
  res.json({
    ok: row.ok === 1,
    pid: process.pid,
    uptime: Math.round(process.uptime()),
    memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    cache: { feed: feedCache.stats(), post: postCache.stats() },
  });
});

// Session table housekeeping, cheap and idempotent.
router.post('/admin/prune', auth.requireUser, auth.requireAdmin, (req, res) => {
  res.json({ removed: pruneSessions() });
});

// ---------------------------------------------------------------------------

router.use((req, res) => fail(res, 404, 'No such endpoint.'));

// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  console.error('[api]', err);
  if (res.headersSent) return;
  fail(res, 500, 'Something broke on our end.');
});

module.exports = { router, sameOrigin, feedCache, postCache, boardCache, imageHandler: imageproxy.handler };
