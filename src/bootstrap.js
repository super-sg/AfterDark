'use strict';

/**
 * First-boot seeding.
 *
 * On a host with a persistent volume this runs once, ever. On a free tier with
 * an ephemeral filesystem it runs on every cold start — which is the only thing
 * that makes a free deploy usable at all, because otherwise the first visitor
 * after a sleep gets an empty site with no boards to post to.
 *
 * Guarded on the boards table rather than on a marker file: a marker on an
 * ephemeral disk is exactly as ephemeral as the database it is supposed to
 * describe, so it would always agree and never help.
 */

const { db } = require('./db');

function needsSeed() {
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM boards').get().n === 0;
  } catch {
    return true;
  }
}

/**
 * Run the seed script in-process. It is written to be idempotent and to exit
 * cleanly, so requiring it is safe; anything it throws is logged rather than
 * taking the worker down, since an unseeded site is still better than no site.
 */
function seedIfEmpty() {
  if (!needsSeed()) return false;
  console.log('[afterdark] empty database — seeding boards, accounts and starter threads');
  try {
    require('../scripts/seed');
    require('./sites').seed();
    console.log('[afterdark] seeded');
    return true;
  } catch (err) {
    console.error('[afterdark] seeding failed:', err.message);
    return false;
  }
}

module.exports = { seedIfEmpty, needsSeed };
