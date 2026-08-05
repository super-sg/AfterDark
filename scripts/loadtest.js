'use strict';

/**
 * Load generator.
 *
 *   node scripts/loadtest.js --users 1000 --seconds 20 --url http://localhost:4173
 *
 * Simulates concurrent browsing users: each holds a keep-alive connection and
 * loops over a realistic request mix (front page, board, thread, newsroom,
 * stats) with a short think-time between requests, which is what "1000 users at
 * once" actually looks like — not 1000 simultaneous in-flight requests.
 *
 * Pass --hammer to drop think-time and measure raw saturation throughput.
 *
 * Each virtual user presents a distinct X-Forwarded-For address, because a
 * thousand real users arrive from a thousand IPs. Run the server with
 * TRUST_PROXY=1 (as you would behind nginx) or the per-IP limiter will
 * correctly reject the whole test as one abusive client.
 */

const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const BASE = new URL(arg('url', 'http://localhost:4173'));
const USERS = Number(arg('users', 1000));
const SECONDS = Number(arg('seconds', 20));
const THINK_MS = flag('hammer') ? 0 : Number(arg('think', 900));
const client = BASE.protocol === 'https:' ? https : http;

const agent = new client.Agent({
  keepAlive: true,
  maxSockets: USERS,
  maxFreeSockets: USERS,
  timeout: 30000,
});

// A signed age cookie is required for content endpoints. Mint one the same way
// the server does so the test exercises the real paths.
require('../src/env');
const { signAgeToken, AGE_TTL_MS } = require('../src/auth');
const AGE_COOKIE = `ad_age=${encodeURIComponent(signAgeToken(Date.now() + AGE_TTL_MS))}`;

const MIX = [
  { weight: 34, path: () => '/api/feed?sort=hot&limit=25' },
  { weight: 14, path: () => '/api/feed?sort=new&limit=25' },
  { weight: 8, path: () => `/api/feed?sort=top&t=week&limit=25` },
  { weight: 16, path: () => `/api/posts/${1 + Math.floor(Math.random() * 10)}` },
  { weight: 10, path: () => '/api/news?limit=20' },
  { weight: 6, path: () => `/api/boards/${['discussion', 'tech', 'policy', 'creators'][Math.floor(Math.random() * 4)]}` },
  { weight: 5, path: () => '/api/boards' },
  { weight: 4, path: () => '/api/stats' },
  { weight: 3, path: () => '/api/news/ticker' },
];

const total = MIX.reduce((sum, m) => sum + m.weight, 0);
function pick() {
  let r = Math.random() * total;
  for (const m of MIX) {
    r -= m.weight;
    if (r <= 0) return m.path();
  }
  return MIX[0].path();
}

const stats = {
  sent: 0,
  ok: 0,
  failed: 0,
  bytes: 0,
  byStatus: new Map(),
  latencies: new Float64Array(4_000_000),
  count: 0,
};

function record(ms, status, bytes) {
  if (stats.count < stats.latencies.length) stats.latencies[stats.count++] = ms;
  stats.byStatus.set(status, (stats.byStatus.get(status) || 0) + 1);
  stats.bytes += bytes;
  if (status >= 200 && status < 400) stats.ok++;
  else stats.failed++;
}

let running = true;

/** Distinct routable-looking source address per virtual user. */
function sourceIp(index) {
  return `203.0.${Math.floor(index / 254) % 254}.${(index % 254) + 1}`;
}

function once(path, ip) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    stats.sent++;
    const req = client.request(
      {
        agent,
        protocol: BASE.protocol,
        hostname: BASE.hostname,
        port: BASE.port,
        path,
        method: 'GET',
        headers: {
          cookie: AGE_COOKIE,
          'accept-encoding': 'gzip',
          connection: 'keep-alive',
          'x-forwarded-for': ip,
        },
      },
      (res) => {
        let bytes = 0;
        res.on('data', (chunk) => (bytes += chunk.length));
        res.on('end', () => {
          record(Number(process.hrtime.bigint() - started) / 1e6, res.statusCode, bytes);
          resolve();
        });
      }
    );
    req.on('error', (err) => {
      record(Number(process.hrtime.bigint() - started) / 1e6, err.code === 'ECONNRESET' ? 599 : 598, 0);
      resolve();
    });
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function virtualUser(index) {
  const ip = sourceIp(index);
  // Stagger arrivals so the ramp is not a thundering herd.
  await new Promise((r) => setTimeout(r, (index / USERS) * 1500));
  while (running) {
    await once(pick(), ip);
    if (THINK_MS) await new Promise((r) => setTimeout(r, THINK_MS * (0.5 + Math.random())));
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function main() {
  console.log(
    `load test → ${BASE.origin}\n` +
      `  virtual users : ${USERS}\n` +
      `  duration      : ${SECONDS}s\n` +
      `  think time    : ${THINK_MS ? `${THINK_MS}ms ±50%` : 'none (saturation mode)'}\n`
  );

  const started = Date.now();
  const users = Array.from({ length: USERS }, (_, i) => virtualUser(i));

  const tick = setInterval(() => {
    const elapsed = (Date.now() - started) / 1000;
    process.stdout.write(
      `\r  ${elapsed.toFixed(0)}s  ${stats.ok} ok  ${stats.failed} failed  ${(stats.ok / elapsed).toFixed(0)} rps   `
    );
  }, 1000);

  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  running = false;
  clearInterval(tick);
  await Promise.all(users);

  const elapsed = (Date.now() - started) / 1000;
  const sorted = Array.from(stats.latencies.slice(0, stats.count)).sort((a, b) => a - b);

  console.log('\n');
  console.log('  requests      :', stats.sent);
  console.log('  successful    :', stats.ok);
  console.log('  failed        :', stats.failed);
  console.log('  throughput    :', `${(stats.ok / elapsed).toFixed(0)} req/s`);
  console.log('  transferred   :', `${(stats.bytes / 1048576).toFixed(1)} MB`);
  console.log('  latency p50   :', `${percentile(sorted, 50).toFixed(1)} ms`);
  console.log('  latency p90   :', `${percentile(sorted, 90).toFixed(1)} ms`);
  console.log('  latency p95   :', `${percentile(sorted, 95).toFixed(1)} ms`);
  console.log('  latency p99   :', `${percentile(sorted, 99).toFixed(1)} ms`);
  console.log('  latency max   :', `${(sorted[sorted.length - 1] || 0).toFixed(1)} ms`);
  console.log('  status codes  :', [...stats.byStatus].map(([s, n]) => `${s}×${n}`).join(' '));

  const errorRate = stats.failed / Math.max(stats.sent, 1);
  const p99 = percentile(sorted, 99);
  console.log(
    `\n  verdict: ${errorRate < 0.005 && p99 < 1000 ? 'PASS' : 'INVESTIGATE'} ` +
      `(errors ${(errorRate * 100).toFixed(2)}%, p99 ${p99.toFixed(0)}ms)`
  );

  process.exit(0);
}

main();
