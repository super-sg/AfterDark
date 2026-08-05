'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Point the data layer at a throwaway database before it is first required.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'afterdark-test-'));
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.SESSION_SECRET = 'test-secret-not-used-in-production';

const store = require('../src/store');
const { hashPassword, verifyPassword, createSession, readSession, destroySession } = require('../src/auth');

process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));

// --- fixtures ---------------------------------------------------------------

const boardId = store.boards.create({ slug: 'testing', name: 'Testing', kind: 'discussion' });
const alice = store.users.create('alice', hashPassword('a-long-enough-password'));
const bob = store.users.create('bob', hashPassword('another-long-password'));
const carol = store.users.create('carol', hashPassword('third-long-password'));

// ---------------------------------------------------------------------------

test('passwords verify only against the right input', () => {
  const stored = hashPassword('correct-horse-battery');
  assert.equal(verifyPassword('correct-horse-battery', stored), true);
  assert.equal(verifyPassword('wrong', stored), false);
  assert.equal(verifyPassword('correct-horse-battery', 'garbage'), false);
});

test('two hashes of the same password differ (salted)', () => {
  assert.notEqual(hashPassword('same'), hashPassword('same'));
});

test('sessions resolve to a user and stop resolving once destroyed', () => {
  const { token } = createSession(alice, 'test-agent');
  assert.equal(readSession(token)?.username, 'alice');
  destroySession(token);
  assert.equal(readSession(token), null);
  assert.equal(readSession('not-a-real-token'), null);
});

test('a new post starts at score 1 with the author auto-upvoted', () => {
  const id = store.posts.create({ boardId, authorId: alice, kind: 'text', title: 'Hello world', body: 'Body' });
  const post = store.posts.get(id);
  assert.equal(post.score, 1);
  assert.equal(post.author, 'alice');
  assert.deepEqual(store.votes.forTargets(alice, 'post', [id]), { [id]: 1 });
});

test('voting is idempotent and reversible, and counters stay consistent', () => {
  const id = store.posts.create({ boardId, authorId: alice, kind: 'text', title: 'Votes', body: 'x' });

  let result = store.votes.cast({ userId: bob, targetType: 'post', targetId: id, value: 1 });
  assert.deepEqual([result.score, result.ups, result.downs], [2, 2, 0]);

  // Same vote again is a no-op, not a double count.
  assert.equal(store.votes.cast({ userId: bob, targetType: 'post', targetId: id, value: 1 }), null);
  assert.equal(store.posts.get(id).score, 2);

  // Flipping to a downvote moves both counters.
  result = store.votes.cast({ userId: bob, targetType: 'post', targetId: id, value: -1 });
  assert.deepEqual([result.score, result.ups, result.downs], [0, 1, 1]);

  // Clearing returns to the starting state.
  result = store.votes.cast({ userId: bob, targetType: 'post', targetId: id, value: 0 });
  assert.deepEqual([result.score, result.ups, result.downs], [1, 1, 0]);
});

test('voting moves the author karma but never self-karma', () => {
  const before = store.users.byId(alice).post_karma;
  const id = store.posts.create({ boardId, authorId: alice, kind: 'text', title: 'Karma', body: 'x' });
  // Creating the post grants exactly one karma from the author's own upvote.
  assert.equal(store.users.byId(alice).post_karma, before + 1);

  store.votes.cast({ userId: bob, targetType: 'post', targetId: id, value: 1 });
  assert.equal(store.users.byId(alice).post_karma, before + 2);

  // The author voting on their own post must not award more.
  const held = store.users.byId(alice).post_karma;
  store.votes.cast({ userId: alice, targetType: 'post', targetId: id, value: 0 });
  assert.equal(store.users.byId(alice).post_karma, held);
});

test('voting on something that does not exist throws NOT_FOUND', () => {
  assert.throws(
    () => store.votes.cast({ userId: bob, targetType: 'post', targetId: 999999, value: 1 }),
    /NOT_FOUND/
  );
});

test('comment trees nest to arbitrary depth in parent-before-child order', () => {
  const postId = store.posts.create({ boardId, authorId: alice, kind: 'text', title: 'Threading', body: 'x' });

  const root = store.comments.create({ postId, parentId: null, authorId: alice, body: 'root' });
  const child = store.comments.create({ postId, parentId: root, authorId: bob, body: 'child' });
  const grandchild = store.comments.create({ postId, parentId: child, authorId: carol, body: 'grandchild' });
  const sibling = store.comments.create({ postId, parentId: root, authorId: carol, body: 'sibling' });

  const { roots, total } = store.comments.tree(postId, 'old');
  assert.equal(total, 4);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].id, root);
  assert.equal(roots[0].replies.length, 2);
  assert.deepEqual(roots[0].replies.map((r) => r.id), [child, sibling]);
  assert.equal(roots[0].replies[0].replies[0].id, grandchild);
  assert.equal(roots[0].replies[0].replies[0].depth, 2);

  // The post's denormalised counter tracked every insert.
  assert.equal(store.posts.get(postId).commentCount, 4);
});

test('a reply pointed at another post is rejected', () => {
  const postA = store.posts.create({ boardId, authorId: alice, kind: 'text', title: 'A', body: 'x' });
  const postB = store.posts.create({ boardId, authorId: alice, kind: 'text', title: 'B', body: 'x' });
  const onA = store.comments.create({ postId: postA, parentId: null, authorId: alice, body: 'on A' });

  assert.throws(
    () => store.comments.create({ postId: postB, parentId: onA, authorId: bob, body: 'wrong thread' }),
    /BAD_PARENT/
  );
});

test('best-sorted comments put the confident score first', () => {
  const postId = store.posts.create({ boardId, authorId: alice, kind: 'text', title: 'Sorting', body: 'x' });
  const weak = store.comments.create({ postId, parentId: null, authorId: alice, body: 'weak' });
  const strong = store.comments.create({ postId, parentId: null, authorId: bob, body: 'strong' });

  store.votes.cast({ userId: bob, targetType: 'comment', targetId: strong, value: 1 });
  store.votes.cast({ userId: carol, targetType: 'comment', targetId: strong, value: 1 });
  store.votes.cast({ userId: carol, targetType: 'comment', targetId: weak, value: -1 });

  const { roots } = store.comments.tree(postId, 'best');
  assert.equal(roots[0].id, strong);
  assert.equal(roots[1].id, weak);
});

test('removed comments keep their place but surrender their text', () => {
  const postId = store.posts.create({ boardId, authorId: alice, kind: 'text', title: 'Removal', body: 'x' });
  const id = store.comments.create({ postId, parentId: null, authorId: bob, body: 'says something bad' });
  store.comments.setRemoved(id, true, alice, 'rule 3');

  const { roots } = store.comments.tree(postId);
  assert.equal(roots[0].removed, true);
  assert.equal(roots[0].body, '');
  assert.equal(roots[0].author, '[removed]');
});

test('keyset pagination walks the whole feed without repeats or gaps', () => {
  const board = store.boards.create({ slug: 'paging', name: 'Paging' });
  const created = [];
  for (let i = 0; i < 25; i++) {
    created.push(store.posts.create({ boardId: board, authorId: alice, kind: 'text', title: `Post ${i}`, body: 'x' }));
  }

  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const page = store.posts.feed({ sort: 'new', boardId: board, cursor, limit: 7 });
    seen.push(...page.items.map((p) => p.id));
    cursor = page.nextCursor;
    pages++;
    assert.ok(pages < 10, 'pagination should terminate');
  } while (cursor);

  assert.equal(seen.length, 25, 'every post appears exactly once');
  assert.equal(new Set(seen).size, 25, 'no duplicates across pages');
  assert.deepEqual(seen, created.slice().reverse(), 'newest first');
});

test('removed posts drop out of feeds', () => {
  const board = store.boards.create({ slug: 'hiding', name: 'Hiding' });
  const keep = store.posts.create({ boardId: board, authorId: alice, kind: 'text', title: 'Keep', body: 'x' });
  const drop = store.posts.create({ boardId: board, authorId: alice, kind: 'text', title: 'Drop', body: 'x' });
  store.posts.setRemoved(drop, true, alice, 'spam');

  const ids = store.posts.feed({ sort: 'new', boardId: board }).items.map((p) => p.id);
  assert.deepEqual(ids, [keep]);
});

test('subscribing is a toggle and keeps the member count honest', () => {
  const board = store.boards.create({ slug: 'subs', name: 'Subs' });
  assert.equal(store.boards.subscribe(alice, board), true);
  assert.equal(store.boards.byId(board).member_count, 1);
  assert.equal(store.boards.subscribe(alice, board), false);
  assert.equal(store.boards.byId(board).member_count, 0);
});

test('full-text search finds posts and survives hostile input', () => {
  const board = store.boards.create({ slug: 'searchable', name: 'Searchable' });
  store.posts.create({
    boardId: board,
    authorId: alice,
    kind: 'text',
    title: 'Age verification compliance across jurisdictions',
    body: 'Ofcom expects highly effective age assurance.',
  });

  const hits = store.posts.search('age verification');
  assert.ok(hits.some((p) => p.title.startsWith('Age verification')));

  // FTS5 operators in user input must not blow up the query.
  assert.doesNotThrow(() => store.posts.search('AND OR NOT "unclosed'));
  assert.doesNotThrow(() => store.posts.search('*'));
});

test('the newsroom orders by publication date, not ingestion order', () => {
  const board = store.boards.create({ slug: 'wire-order', name: 'Wire order', kind: 'news' });
  const day = 86400e3;
  const now = Date.now();

  // Ingested oldest-published first, as a backfilling feed pull would.
  const old = store.posts.create({
    boardId: board, authorId: null, kind: 'article', title: 'Published last year',
    wireGuid: 'src:old', publishedAt: now - 300 * day, url: 'https://example.com/a',
  });
  const recent = store.posts.create({
    boardId: board, authorId: null, kind: 'article', title: 'Published yesterday',
    wireGuid: 'src:recent', publishedAt: now - day, url: 'https://example.com/b',
  });

  const byPublished = store.posts.feed({ sort: 'published', boardId: board }).items.map((p) => p.id);
  assert.deepEqual(byPublished, [recent, old], 'newest publication first');

  // Ingestion order would have put the older story on top — that is the bug.
  const byCreated = store.posts.feed({ sort: 'new', boardId: board }).items.map((p) => p.id);
  assert.deepEqual(byCreated, [recent, old].sort((a, b) => b - a));
});

test('published-sort pagination stays consistent across pages', () => {
  const board = store.boards.create({ slug: 'wire-pages', name: 'Wire pages', kind: 'news' });
  const day = 86400e3;
  const created = [];
  for (let i = 0; i < 12; i++) {
    created.push(store.posts.create({
      boardId: board, authorId: null, kind: 'article', title: `Wire ${i}`,
      wireGuid: `pages:${i}`, publishedAt: Date.now() - i * day, url: `https://example.com/${i}`,
    }));
  }

  const seen = [];
  let cursor = null;
  do {
    const page = store.posts.feed({ sort: 'published', boardId: board, cursor, limit: 5 });
    seen.push(...page.items.map((p) => p.id));
    cursor = page.nextCursor;
  } while (cursor);

  assert.equal(seen.length, 12);
  assert.equal(new Set(seen).size, 12);
  assert.deepEqual(seen, created, 'ordered newest-published first, no repeats');
});

test('wire items deduplicate on their GUID', () => {
  const board = store.boards.create({ slug: 'wire-test', name: 'Wire', kind: 'news' });
  const guid = 'XBIZ:https://example.com/story-1';
  store.posts.create({
    boardId: board, authorId: null, kind: 'article', title: 'Story one',
    body: 'summary', url: 'https://example.com/story-1', sourceName: 'XBIZ',
    sourceUrl: 'https://example.com/story-1', wireGuid: guid, publishedAt: Date.now(),
  });

  assert.equal(store.posts.wireExists(guid), true);
  assert.throws(
    () => store.posts.create({
      boardId: board, authorId: null, kind: 'article', title: 'Story one again',
      body: 'summary', url: 'https://example.com/story-1', wireGuid: guid,
    }),
    /UNIQUE/
  );
});
