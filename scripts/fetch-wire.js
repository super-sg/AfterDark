'use strict';

/**
 * Pull every enabled source once and exit. Useful for cron, or for filling the
 * boards immediately after seeding instead of waiting for the server's timer.
 *
 *   npm run wire              pull everything enabled
 *   npm run wire -- --status  show the registry and its health, pull nothing
 *   npm run wire -- xbiz avn  pull only these sources
 *
 * The status table matters more than it sounds: which publishers are reachable
 * depends entirely on the network this runs on. A filtered connection will
 * starve half the registry, and that must be visible rather than looking like
 * a quiet news day.
 */

require('../src/env');

const { ingest } = require('../src/wire');
const sources = require('../src/sources');

sources.syncBuiltins();

const args = process.argv.slice(2).filter((a) => a !== '--');
const statusOnly = args.includes('--status');
const only = args.filter((a) => !a.startsWith('--'));

const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
const ago = (ts) => {
  if (!ts) return 'never';
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
};

function printRegistry() {
  const list = sources.all();
  console.log(`\n${pad('SOURCE', 16)} ${pad('KIND', 6)} ${pad('BOARD', 11)} ${pad('ON', 4)} ${pad('LAST OK', 10)} ${pad('STATUS', 8)} NOTE`);
  console.log('─'.repeat(100));
  for (const s of list) {
    const note = s.lastError || s.note || '';
    console.log(
      `${pad(s.id, 16)} ${pad(s.kind, 6)} ${pad(s.board, 11)} ${pad(s.enabled ? 'yes' : 'no', 4)} `
      + `${pad(ago(s.lastOkAt), 10)} ${pad(s.lastStatus || '-', 8)} ${note.slice(0, 46)}`
    );
  }
  const live = list.filter((s) => s.enabled && s.lastOkAt).length;
  console.log(`\n${live}/${list.filter((s) => s.enabled).length} enabled sources have succeeded at least once.`);
}

(async () => {
  if (statusOnly) {
    printRegistry();
    process.exit(0);
  }

  const targets = only.length ? only : sources.enabled().map((s) => s.id);
  console.log(`pulling ${targets.length} source${targets.length === 1 ? '' : 's'}…\n`);

  const summary = await ingest({ only: only.length ? only : null, log: (line) => console.log(line) });

  console.log(`\nadded   : ${summary.added}`);
  console.log(`skipped : ${summary.skipped} (already seen)`);
  console.log(`blocked : ${summary.blocked} (failed content screening)`);

  const ok = summary.perSource.filter((s) => s.status === 'ok');
  const bad = summary.perSource.filter((s) => s.status !== 'ok');

  if (ok.length) {
    console.log('\nreached:');
    for (const s of ok) console.log(`  ✓ ${pad(s.name, 24)} ${s.seen} items, ${s.added} new`);
  }
  if (bad.length) {
    console.log('\nunreachable:');
    for (const s of bad) console.log(`  ✗ ${pad(s.name, 24)} ${s.error}`);
    console.log(
      '\nA source that fails everywhere has usually moved — check its URL in src/sources.js.'
      + '\nA source that fails only here is your network: adult domains are commonly'
      + '\nintercepted by ISP and workplace filters, which return a block page instead'
      + '\nof the feed. Deploy somewhere unfiltered and re-run this to confirm.'
    );
  }

  printRegistry();
  process.exit(0);
})().catch((err) => {
  console.error('wire pull failed:', err.message);
  process.exit(1);
});
