'use strict';

/**
 * One scheduled pass: pull the wire, then fill in artwork for whatever arrived.
 *
 * This exists because Passenger-hosted apps are stopped when idle, which makes
 * in-process timers unreliable in the one way that matters — the site looks
 * fine, the front page just quietly stops moving. Cron owns the schedule
 * instead, and the process exits when it is done rather than lingering against
 * the account's process limit.
 *
 *   0,10,20,30,40,50 * * * *  cd ~/<app-root> && node scripts/cron-tick.js >> ~/logs/wire.log 2>&1
 *
 * (Written out rather than as a step value, because the shorter form contains
 * the two characters that end a block comment.)
 *
 * Every run prints a line whether or not anything changed. A job that only logs
 * on change makes a working wire and a dead one look identical.
 */

require('../src/env');

const { ingest } = require('../src/wire');
const { enrichPending, warmPending } = require('../src/enrich');
const { reheatRecentPosts, pruneSessions } = require('../src/db');

require('../src/sources').syncBuiltins();

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

(async () => {
  const summary = await ingest();
  const ok = summary.perSource.filter((s) => s.status === 'ok').length;
  console.log(
    `[${stamp()}] wire: ${ok}/${summary.perSource.length} sources`
    + ` · +${summary.added} new · ${summary.skipped} already had`
  );
  // Name what is unreachable. On a filtered or blocked connection half the
  // registry returns nothing, and that must not read as a quiet news day.
  if (summary.errors.length) {
    console.warn(`[${stamp()}] unreachable: ${summary.errors.map((e) => `${e.source} (${e.error})`).join('; ')}`);
  }

  // Limits are modest on purpose: this shares a box with other tenants, and
  // image encoding is the part that gets an account throttled.
  const enriched = await enrichPending({ limit: Number(process.env.ENRICH_LIMIT) || 10 });
  const warmed = await warmPending({ limit: Number(process.env.WARM_LIMIT) || 16 });
  console.log(
    `[${stamp()}] media: enriched ${enriched.enriched}/${enriched.scanned}`
    + ` · warmed ${warmed.warmed}/${warmed.scanned}`
  );

  // Recompute decay so the front page moves.
  //
  // Hot rank is a stored number, not something worked out per request, so it
  // only falls as time passes if something recomputes it. In-process that was
  // a timer in server.js -- which under Passenger runs only while somebody
  // happens to be reading the site, and never at all once it idles out. The
  // visible symptom is the one reported here: the wire keeps adding stories,
  // the feed keeps accepting them, and the front page does not move, because
  // the posts already at the top never cool down.
  const reheated = reheatRecentPosts();
  const sessions = pruneSessions();
  console.log(`[${stamp()}] rank: reheated ${reheated ?? 'n/a'} posts · pruned ${sessions} sessions`);
})().then(
  () => process.exit(0),
  (err) => {
    console.error(`[${stamp()}] tick failed: ${err.stack || err.message}`);
    process.exit(1);
  }
);
