'use strict';

/**
 * AfterDark — server entry point.
 *
 * Runs one Node process per CPU core behind the OS load balancer. Each worker
 * holds its own SQLite connection and its own read caches; SQLite's WAL mode
 * lets them all read in parallel while one writes. That shape comfortably
 * carries a few thousand concurrent readers on a single box.
 */

require('./src/env');

const cluster = require('node:cluster');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.PORT) || 8080;

function workerCount() {
  const raw = String(process.env.CLUSTER ?? 'auto').toLowerCase();
  if (raw === '0' || raw === '1' || raw === 'off' || raw === 'false') return 1;
  const cores = os.cpus().length;
  if (raw === 'auto' || raw === 'true' || raw === '') return Math.max(2, Math.min(cores - 1, 8));
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

const WORKERS = workerCount();

if (cluster.isPrimary && WORKERS > 1) {
  console.log(`[afterdark] primary ${process.pid} starting ${WORKERS} workers on :${PORT}`);
  for (let i = 0; i < WORKERS; i++) cluster.fork({ WORKER_INDEX: String(i) });

  cluster.on('exit', (worker, code, signal) => {
    if (worker.exitedAfterDisconnect) return;
    console.error(`[afterdark] worker ${worker.process.pid} died (${signal || code}); restarting`);
    cluster.fork({ WORKER_INDEX: String(worker.id) });
  });

  const shutdown = () => {
    console.log('[afterdark] shutting down');
    for (const worker of Object.values(cluster.workers)) worker.disconnect();
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} else {
  startWorker();
}

function startWorker() {
  const express = require('express');
  const compression = require('compression');
  const cookieParser = require('cookie-parser');
  const helmet = require('helmet');
  const rateLimit = require('express-rate-limit');

  const { attachUser } = require('./src/auth');
  const { router, sameOrigin, imageHandler } = require('./src/routes');
  const { pruneSessions, reheatRecentPosts } = require('./src/db');

  // Reconcile the declared source registry with the database on boot, so a new
  // source in src/sources.js is live after a restart with no migration step.
  // A cold start on an ephemeral filesystem means an empty database. Seed it
  // before anything serves, and only from the scheduler worker so eight of them
  // do not race each other through the same INSERTs.
  if (process.env.WORKER_INDEX === '0' || WORKERS === 1) {
    require('./src/bootstrap').seedIfEmpty();
  }

  require('./src/sources').syncBuiltins();
  require('./src/sites').seed();

  const app = express();
  app.disable('x-powered-by');
  app.set('etag', 'strong');

  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          // Board accents and image tints are injected as inline custom properties.
          styleSrc: ["'self'", "'unsafe-inline'"],
          // Every publisher image is re-served from /i/, so no remote hosts here.
          imgSrc: ["'self'", 'data:', 'blob:'],
          connectSrc: ["'self'"],
          // Fonts are self-hosted in public/fonts — no Google Fonts request.
          fontSrc: ["'self'"],
          mediaSrc: ["'self'", 'data:'],
          // Video players are only injected after an explicit click-to-play.
          // 'self' also covers the sandboxed /ads/ frames — no ad host appears
          // here, so nothing third-party can execute in the main document.
          frameSrc: ["'self'", 'https://www.youtube-nocookie.com', 'https://player.vimeo.com'],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
        },
      },
      // Adult sites are commonly linked from elsewhere; a strict COEP breaks
      // nothing here but complicates future embeds.
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    })
  );

  // Tell crawlers and browsers this is adult material.
  app.use((req, res, next) => {
    res.set('Rating', 'RTA-5042-1996-1400-1577-RTA');
    next();
  });

  app.use(compression({ threshold: 1024 }));
  app.use(express.json({ limit: '128kb' }));
  app.use(cookieParser());

  // Coarse per-IP ceiling. Per-action limits live in src/moderation.js.
  app.use(
    '/api/',
    rateLimit({
      windowMs: 60_000,
      limit: 600,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: 'Rate limited. Slow down.' },
    })
  );

  // Proxied publisher images. Outside /api so it is not JSON-rate-limited: a
  // single feed render legitimately asks for 25 of these at once.
  app.get(
    '/i/:preset/:sig',
    rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: false, legacyHeaders: false }),
    imageHandler
  );

  // Ad frames. Served from our own origin so the main document's CSP never has
  // to name a third party, but embedded sandboxed *without* allow-same-origin,
  // so the tag inside runs at an opaque origin and can reach neither the
  // session cookie nor the parent DOM. See src/ads.js.
  app.get('/ads/:slot', require('./src/ads').handler);

  app.use('/api/', sameOrigin, attachUser, router);

  app.use(
    express.static(path.join(__dirname, 'public'), {
      maxAge: '1h',
      etag: true,
      setHeaders(res, filePath) {
        // Hashed asset names would allow immutable caching; until then, keep
        // the shell revalidating so deploys land immediately.
        if (filePath.endsWith('.html')) res.set('Cache-Control', 'no-cache');
      },
    })
  );

  // Client-side routing: anything not an API call or a file gets the shell.
  app.get('*', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  const server = app.listen(PORT, () => {
    console.log(`[afterdark] worker ${process.pid} listening on http://localhost:${PORT}`);
  });

  // Keep-alive tuning: browsers hold connections open, and a headroom gap
  // between these two avoids 502s behind a proxy.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.maxRequestsPerSocket = 0;

  // One worker runs the periodic jobs so they don't stampede.
  const isScheduler = process.env.WORKER_INDEX === '0' || WORKERS === 1;
  if (isScheduler) {
    const hourly = setInterval(() => {
      const removed = pruneSessions();
      if (removed) console.log(`[afterdark] pruned ${removed} expired sessions`);
    }, 3600_000);
    hourly.unref();

    // Recompute decay so the front page moves even when voting is quiet.
    const reheat = setInterval(() => reheatRecentPosts(), 600_000);
    reheat.unref();

    // Trim the proxied-image cache weekly.
    const { sweepCache } = require('./src/imageproxy');
    const sweep = setInterval(() => {
      sweepCache().then(({ removed, bytes }) => {
        if (removed) console.log(`[images] swept ${removed} stale files, ${(bytes / 1048576).toFixed(0)} MB live`);
      });
    }, 24 * 3600_000);
    sweep.unref();

    // Fill in Open Graph images for anything posted without one, then tint and
    // pre-render whatever already arrived with its own artwork.
    const { enrichPending, warmPending } = require('./src/enrich');
    const enrich = () => {
      enrichPending({ limit: 15 })
        .then((s) => {
          if (s.enriched) console.log(`[media] enriched ${s.enriched}/${s.scanned} posts`);
          return warmPending({ limit: 24 });
        })
        .then((s) => {
          if (s.warmed) console.log(`[media] warmed ${s.warmed}/${s.scanned} feed images`);
        })
        .catch((err) => console.warn('[media] enrichment failed:', err.message));
    };
    setTimeout(enrich, 25_000).unref();
    setInterval(enrich, 5 * 60_000).unref();

    if (process.env.WIRE_AUTO !== '0') {
      const { ingest } = require('./src/wire');
      const pull = () => {
        ingest()
          .then((s) => {
            if (s.added) console.log(`[wire] +${s.added} items (${s.skipped} dupes)`);
            // Name the unreachable sources: on a filtered network half the
            // registry silently returns nothing, and that must not look like
            // "the industry published no news today".
            if (s.errors.length) {
              console.warn('[wire] unreachable:', s.errors.map((e) => `${e.source} (${e.error})`).join('; '));
            }
            if (s.added) enrich();
          })
          .catch((err) => console.warn('[wire] pull failed:', err.message));
      };
      setTimeout(pull, 15_000).unref();
      setInterval(pull, 20 * 60_000).unref();
    }
  }

  const close = () => server.close(() => process.exit(0));
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
  process.on('disconnect', close);
}
