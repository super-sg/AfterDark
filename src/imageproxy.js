'use strict';

/**
 * Image proxy.
 *
 * Publisher images are never hotlinked into the page. Every one is fetched by
 * us, re-encoded to WebP at the size the layout actually needs, and served from
 * our own origin. That buys four things:
 *
 *   - Privacy. The reader's browser never talks to a publisher's CDN, so no
 *     third party learns which adult-industry stories a given IP reads. On a
 *     site like this that is not a nicety.
 *   - A tight CSP. `img-src 'self' data:` stays intact.
 *   - Bandwidth. A 1200×630 hero becomes a 25 KB WebP thumbnail.
 *   - Stability. Hotlinks rot; the cache does not.
 *
 * URLs are HMAC-signed, so this is not an open proxy that anyone can point at
 * arbitrary hosts.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');

const { safeFetch } = require('./media');

const SECRET = process.env.SESSION_SECRET || 'dev-only-insecure-secret';
const CACHE_DIR = process.env.IMAGE_CACHE_DIR
  || path.join(path.dirname(process.env.DB_PATH || './data/afterdark.db'), 'imgcache');
const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 12000;

fs.mkdirSync(CACHE_DIR, { recursive: true });

/**
 * Cap libvips' thread pool.
 *
 * Left alone, sharp sizes its pool from os.cpus().length -- which reports the
 * *host's* cores, not the share of a core a container is actually allowed. On a
 * small instance (Render's free plan is 0.1 CPU) that means eight encode threads
 * fighting over a tenth of one core, and the event loop loses. Requests that
 * take 60ms on an idle box take six seconds while a batch of images is warming,
 * which is long enough for a platform health check to give up and restart the
 * service.
 *
 * Encoding is background work. It is allowed to be slow; it is not allowed to
 * make the site slow.
 */
sharp.concurrency(Math.max(1, Number(process.env.SHARP_CONCURRENCY) || 1));
sharp.cache({ memory: 32 });

/**
 * Layout slots. Nothing else is renderable, so nothing else is fetchable.
 *
 * The `-blur` variants are how explicit artwork reaches the page: rendered
 * small, blurred past legibility and re-upscaled by CSS, so the card has the
 * right colour and composition without showing anything until the reader asks.
 * They are separate presets rather than a flag because the preset name is part
 * of the HMAC — a signature for the blurred version cannot be replayed to fetch
 * the sharp one.
 */
const BLUR = { sigma: 24, downscale: 0.18 };

const PRESETS = {
  thumb: { width: 320, height: 240, fit: 'cover', quality: 72 },
  card: { width: 800, height: 420, fit: 'cover', quality: 76 },
  wide: { width: 1200, height: 630, fit: 'cover', quality: 78 },
  hero: { width: 1400, height: 780, fit: 'cover', quality: 80 },
  square: { width: 320, height: 320, fit: 'cover', quality: 74 },
  avatar: { width: 96, height: 96, fit: 'cover', quality: 78 },
};

// Every visual slot gets a blurred twin. Blurred images carry almost no detail,
// so they encode to a couple of kilobytes at low quality.
for (const [name, spec] of Object.entries({ ...PRESETS })) {
  if (name === 'avatar') continue;
  PRESETS[`${name}-blur`] = {
    ...spec,
    width: Math.max(32, Math.round(spec.width * BLUR.downscale)),
    height: Math.max(32, Math.round(spec.height * BLUR.downscale)),
    quality: 45,
    blur: BLUR.sigma * BLUR.downscale,
  };
}

const ALLOWED_INPUT = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

function sign(url, preset) {
  return crypto
    .createHmac('sha256', SECRET)
    .update(`${preset}\n${url}`)
    .digest('base64url')
    .slice(0, 22);
}

function verify(url, preset, signature) {
  const expected = sign(url, preset);
  const a = Buffer.from(String(signature));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Build the on-site URL for a remote image. Returns '' if unusable. */
function proxyUrl(remoteUrl, preset = 'card') {
  if (!remoteUrl || !PRESETS[preset]) return '';
  if (!/^https?:\/\//i.test(remoteUrl)) return '';
  return `/i/${preset}/${sign(remoteUrl, preset)}?u=${encodeURIComponent(remoteUrl)}`;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const cachePath = (url, preset) =>
  path.join(CACHE_DIR, `${crypto.createHash('sha256').update(`${preset}\n${url}`).digest('hex')}.webp`);

// Collapses stampedes: fifty readers hitting one uncached hero fetch once.
const inFlight = new Map();

async function render(url, preset) {
  const file = cachePath(url, preset);
  try {
    return await fsp.readFile(file);
  } catch {
    /* cache miss */
  }

  if (inFlight.has(file)) return inFlight.get(file);

  const job = (async () => {
    const { buffer, contentType } = await safeFetch(url, {
      maxBytes: MAX_SOURCE_BYTES,
      timeoutMs: FETCH_TIMEOUT_MS,
      accept: 'image/avif,image/webp,image/png,image/jpeg,*/*;q=0.8',
    });
    if (!ALLOWED_INPUT.has(contentType)) throw new Error(`not an image (${contentType || 'unknown'})`);

    const spec = PRESETS[preset];
    let pipeline = sharp(buffer, { animated: false, limitInputPixels: 40e6 })
      .rotate()
      .resize(spec.width, spec.height, { fit: spec.fit, position: 'attention', withoutEnlargement: true });

    // Blur *after* the downscale: at 18% scale the detail is already gone, and
    // blurring the small image costs a fraction of blurring the full-size one.
    if (spec.blur) pipeline = pipeline.blur(spec.blur);

    const out = await pipeline.webp({ quality: spec.quality, effort: 4 }).toBuffer();

    // Write via a temp file so a concurrent reader never sees a partial image.
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, out);
    await fsp.rename(tmp, file);
    return out;
  })().finally(() => inFlight.delete(file));

  inFlight.set(file, job);
  return job;
}

/**
 * Dominant colour of a remote image, used to tint the placeholder so a card has
 * the right "shape" before the picture arrives. Cheap, cached, best-effort.
 */
const colourCache = new Map();

async function dominantColour(url) {
  if (colourCache.has(url)) return colourCache.get(url);
  try {
    const buffer = await render(url, 'thumb');
    const { dominant } = await sharp(buffer).stats();
    const hex = `#${[dominant.r, dominant.g, dominant.b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
    if (colourCache.size > 5000) colourCache.clear();
    colourCache.set(url, hex);
    return hex;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Express handler
// ---------------------------------------------------------------------------

function handler(req, res) {
  const preset = req.params.preset;
  const signature = req.params.sig;
  const url = String(req.query.u || '');

  if (!PRESETS[preset]) return res.status(404).end();
  if (!url || !verify(url, preset, signature)) return res.status(403).end();

  render(url, preset)
    .then((buffer) => {
      res.set({
        'Content-Type': 'image/webp',
        // The signature pins the (url, preset) pair, so the bytes never change.
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Length': String(buffer.length),
        'Cross-Origin-Resource-Policy': 'same-origin',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(buffer);
    })
    .catch(() => {
      // Short negative cache: a dead publisher image should not be retried on
      // every single feed render, but should recover within the hour.
      res.set('Cache-Control', 'public, max-age=3600');
      res.status(404).end();
    });
}

/** Drop cache entries older than `maxAgeMs`. Called on a timer by the scheduler. */
async function sweepCache(maxAgeMs = 30 * 86400e3) {
  let removed = 0;
  let bytes = 0;
  try {
    const cutoff = Date.now() - maxAgeMs;
    for (const name of await fsp.readdir(CACHE_DIR)) {
      const file = path.join(CACHE_DIR, name);
      const stat = await fsp.stat(file).catch(() => null);
      if (!stat) continue;
      if (stat.mtimeMs < cutoff) {
        await fsp.unlink(file).catch(() => {});
        removed++;
      } else {
        bytes += stat.size;
      }
    }
  } catch {
    /* cache sweeping is best-effort */
  }
  return { removed, bytes };
}

module.exports = { proxyUrl, sign, verify, handler, render, dominantColour, sweepCache, PRESETS, CACHE_DIR };
