'use strict';

/**
 * Ranking maths, modelled on Reddit's published algorithms.
 *
 *  - hotRank      → front-page ordering: score, decayed by age
 *  - confidence   → comment "best" ordering: Wilson score lower bound
 *  - risingScore  → velocity: score per hour, damped for very young posts
 */

const EPOCH = 1700000000; // seconds; arbitrary but fixed reference point
const DECAY = 45000; // seconds ≈ 12.5h; a post needs ~10x the score to hold rank

function hotRank(score, createdAtMs) {
  const s = Number(score) || 0;
  const order = Math.log10(Math.max(Math.abs(s), 1));
  const sign = s > 0 ? 1 : s < 0 ? -1 : 0;
  const seconds = (Number(createdAtMs) || 0) / 1000 - EPOCH;
  return Number((sign * order + seconds / DECAY).toFixed(7));
}

// z = 1.281551565545 → 80% confidence, the constant Reddit uses.
const Z = 1.281551565545;

function confidence(ups, downs) {
  const n = (Number(ups) || 0) + (Number(downs) || 0);
  if (n === 0) return 0;
  const p = ups / n;
  const left = p + (Z * Z) / (2 * n);
  const right = Z * Math.sqrt((p * (1 - p) + (Z * Z) / (4 * n)) / n);
  const under = 1 + (Z * Z) / n;
  return Number(((left - right) / under).toFixed(7));
}

function risingScore(score, createdAtMs, now = Date.now()) {
  const ageHours = Math.max((now - createdAtMs) / 3600000, 0.25);
  // Damp the first two hours so a single vote on a brand new post can't top the list.
  const damping = Math.min(1, ageHours / 2);
  return (Number(score) || 0) * damping / ageHours;
}

module.exports = { hotRank, confidence, risingScore, EPOCH, DECAY };
