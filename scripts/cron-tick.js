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
})().then(
  () => process.exit(0),
  (err) => {
    console.error(`[${stamp()}] tick failed: ${err.stack || err.message}`);
    process.exit(1);
  }
);
