'use strict';

/**
 * Background media enrichment.
 *
 * Fetching a publisher's page to read its Open Graph tags takes seconds. That
 * must never happen while a user waits on a POST, so posting records the link
 * and returns immediately, and this pass fills in the picture afterwards. The
 * card gets its generated cover in the meantime and quietly upgrades to the
 * real image on the next load.
 *
 * Two passes, because pictures now arrive by two routes:
 *
 *   - `enrichPending` scrapes Open Graph tags for links that came with nothing.
 *   - `warmPending` handles items whose feed already carried artwork: they skip
 *     scraping entirely but still need a tint and warmed proxy renditions, or
 *     the first reader to scroll past pays for the fetch-and-resize.
 */

const store = require('./store');
const { enrichLink } = require('./media');
const { dominantColour, render, PRESETS } = require('./imageproxy');

const CONCURRENCY = 3; // polite to publishers, plenty fast for a feed

// Sizes a feed actually asks for. Rendering them here means the first reader to
// see a new story gets it from disk instead of waiting on a fetch-and-resize.
const WARM_PRESETS = ['thumb', 'card', 'wide', 'hero'];

/**
 * Explicit artwork is only ever *served* blurred until a reader opts in, so the
 * blurred renditions are the ones that must be warm. The sharp sizes are warmed
 * too — a reveal that stalls for two seconds is a reveal nobody repeats.
 */
function presetsFor(nsfw) {
  const names = nsfw ? WARM_PRESETS.flatMap((p) => [`${p}-blur`, p]) : WARM_PRESETS;
  return names.filter((p) => PRESETS[p]);
}

async function warm(url, nsfw) {
  await Promise.all(presetsFor(nsfw).map((preset) => render(url, preset).catch(() => null)));
}

/** Run `task` over `items` with a fixed number of workers. */
async function pool(items, task) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length) await task(queue.shift());
    })
  );
}

/**
 * Enrich up to `limit` posts that are missing media.
 * @returns {Promise<{scanned:number, enriched:number, failed:number}>}
 */
async function enrichPending({ limit = 20, log = () => {} } = {}) {
  const pending = store.posts.needingMedia(limit);
  const summary = { scanned: pending.length, enriched: 0, failed: 0 };
  if (!pending.length) return summary;

  await pool(pending, async (post) => {
    const target = post.url || post.source_url;
    if (!target) return;
    const nsfw = !!post.nsfw;

    try {
      const media = await enrichLink(target);
      if (!media.imageUrl && !media.videoKind) {
        // Mark it done with a sentinel so we do not re-fetch forever.
        store.posts.setMedia(post.id, { videoKind: media.videoKind || 'none' });
        summary.failed++;
        return;
      }

      // A picture already used by three other posts is the publisher's
      // house logo, not this article's art. The generated cover is better.
      if (media.imageUrl && store.posts.imageUsage(media.imageUrl) >= 3) {
        store.posts.setMedia(post.id, { videoKind: 'none' });
        summary.failed++;
        log(`  media: #${post.id} skipped generic house image`);
        return;
      }

      const tint = media.imageUrl ? await dominantColour(media.imageUrl) : '';
      store.posts.setMedia(post.id, {
        imageUrl: media.imageUrl,
        imageAlt: media.imageAlt,
        imageW: media.imageWidth,
        imageH: media.imageHeight,
        imageTint: tint || '-',
        videoKind: media.videoKind || 'none',
        videoId: media.videoId,
      });
      if (media.imageUrl) await warm(media.imageUrl, nsfw);

      summary.enriched++;
      log(`  media: #${post.id} ${media.videoKind || 'image'} ${media.imageUrl.slice(0, 70)}`);
    } catch (err) {
      store.posts.setMedia(post.id, { videoKind: 'none' });
      summary.failed++;
      log(`  media: #${post.id} failed — ${err.message}`);
    }
  });

  return summary;
}

/**
 * Tint and pre-render posts that arrived with their own artwork.
 * @returns {Promise<{scanned:number, warmed:number, failed:number}>}
 */
async function warmPending({ limit = 24, log = () => {} } = {}) {
  const pending = store.posts.needingWarm(limit);
  const summary = { scanned: pending.length, warmed: 0, failed: 0 };
  if (!pending.length) return summary;

  await pool(pending, async (post) => {
    try {
      const tint = await dominantColour(post.image_url);
      store.posts.setTint(post.id, tint);
      await warm(post.image_url, !!post.nsfw);
      summary.warmed++;
    } catch (err) {
      // Mark it anyway: an image we cannot fetch will not become fetchable by
      // being retried every five minutes forever.
      store.posts.setTint(post.id, '');
      summary.failed++;
      log(`  warm: #${post.id} failed — ${err.message}`);
    }
  });

  return summary;
}

module.exports = { enrichPending, warmPending };
