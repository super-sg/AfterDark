'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { hotRank, confidence, risingScore } = require('../src/ranking');

const HOUR = 3600e3;

test('hot rank prefers the higher score at equal age', () => {
  const now = Date.now();
  assert.ok(hotRank(500, now) > hotRank(50, now));
});

test('hot rank prefers the newer post at equal score', () => {
  const now = Date.now();
  assert.ok(hotRank(100, now) > hotRank(100, now - 24 * HOUR));
});

test('hot rank decays logarithmically — 10x the score buys ~12.5 hours', () => {
  const now = Date.now();
  // A post ten times better should outrank one roughly half a day newer.
  assert.ok(hotRank(1000, now - 12 * HOUR) > hotRank(100, now));
  // But not one that is several days newer.
  assert.ok(hotRank(1000, now - 96 * HOUR) < hotRank(100, now));
});

test('hot rank pushes negative scores below zero-score posts', () => {
  const now = Date.now();
  assert.ok(hotRank(-50, now) < hotRank(0, now));
});

test('confidence is a lower bound, so small samples rank below proven ones', () => {
  // 1 upvote out of 1 looks perfect but is barely evidence.
  const tiny = confidence(1, 0);
  const proven = confidence(200, 20);
  assert.ok(proven > tiny, 'a well-sampled 90% should beat an unsampled 100%');
  assert.ok(tiny > 0 && tiny < 1);
});

test('confidence penalises downvotes and handles the empty case', () => {
  assert.equal(confidence(0, 0), 0);
  assert.ok(confidence(100, 0) > confidence(100, 50));
  assert.ok(confidence(10, 90) < 0.2);
});

test('rising damps the first two hours so one vote cannot top the list', () => {
  const now = Date.now();
  const brandNew = risingScore(5, now - 10 * 60e3, now);
  const proven = risingScore(60, now - 3 * HOUR, now);
  assert.ok(proven > brandNew, 'a sustained climb should beat a single early vote');
});

test('rising rewards velocity over raw score', () => {
  const now = Date.now();
  const fast = risingScore(100, now - 3 * HOUR, now);
  const slow = risingScore(300, now - 40 * HOUR, now);
  assert.ok(fast > slow);
});
