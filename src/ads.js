'use strict';

/**
 * Ad slots.
 *
 * The whole site runs under `script-src 'self'` — no inline script, no third
 * party, which is what keeps a session cookie on an adult site safe from
 * whatever an ad network decides to ship this week. Ad tags are third-party
 * script by definition, so pasting them into the page would mean deleting that
 * guarantee for every reader on every page.
 *
 * Instead each slot is an `<iframe>` pointing at `/ads/:slot` on our own origin,
 * carrying `sandbox="allow-scripts allow-popups"` **without** `allow-same-origin`.
 * That gives the ad script an opaque origin: it runs, it renders, it can open
 * its click-through — and it cannot read `document.cookie`, reach into the
 * parent DOM, or see a single thing about the reader's session. The main
 * document's CSP is untouched; the frame gets its own, listing exactly the ad
 * hosts and nothing else.
 *
 * Slots start collapsed and open only once the frame reports that a real
 * creative landed. Reserving the box up front is the textbook way to avoid
 * layout shift, but it leaves a grey labelled rectangle on every page where the
 * network is blocked or the inventory is unsold — and a page of those is the
 * loudest possible signal that nobody looked at the result. The expansion is
 * animated, so a late fill reads as the page settling rather than jumping.
 */

const ENABLED = process.env.ADS_ENABLED !== '0';

/**
 * Publisher units. These are Adsterra banner tags: the page declares an
 * `atOptions` object and then loads the matching invoke script.
 */
const UNITS = {
  leaderboard: { key: '706391201d37146b3f5648b9f60cc563', width: 728, height: 90 },
  mobileBanner: { key: '6296b31152b76c8eb8736eee3f7432ed', width: 320, height: 50 },
  skyscraper: { key: 'fbcbdb2eff3398fdb549b7484177176a', width: 160, height: 600 },
  rectangle: { key: 'ea92ef6e3159844ad092369efe6f02ed', width: 300, height: 250 },
  banner: { key: '4a49d14c6e857ca46740887d05bfb6bf', width: 468, height: 60 },
};

/** The native-recommendation widget sizes itself, so it has no fixed box. */
const NATIVE = {
  script: 'https://pl30412496.effectivecpmnetwork.com/8d23cadd0711f190c1e11b03a64021b8/invoke.js',
  container: 'container-8d23cadd0711f190c1e11b03a64021b8',
  height: 320,
};

const BANNER_HOST = 'https://www.highperformanceformat.com';
const NATIVE_HOST = 'https://pl30412496.effectivecpmnetwork.com';

/**
 * Placements. Each names a desktop unit and, where the desktop one will not
 * fit, a narrow-screen replacement — a 728×90 leaderboard on a 390px phone is
 * a horizontal scrollbar, not an impression.
 */
const SLOTS = {
  // Above the feed.
  top: { desktop: 'leaderboard', mobile: 'mobileBanner', label: 'Advertisement' },
  // Right rail: a rectangle high up, a skyscraper below the fold.
  rail: { desktop: 'rectangle', mobile: null, label: 'Advertisement' },
  railTall: { desktop: 'skyscraper', mobile: null, label: 'Advertisement' },
  // Left rail, under the navigation.
  railLeft: { desktop: 'rectangle', mobile: null, label: 'Advertisement' },
  // Under a post body, and under the comment thread.
  article: { desktop: 'banner', mobile: 'mobileBanner', label: 'Advertisement' },
  comments: { desktop: 'leaderboard', mobile: 'mobileBanner', label: 'Advertisement' },
  // Between sections on the directory and community index.
  section: { desktop: 'banner', mobile: 'mobileBanner', label: 'Advertisement' },
  // Bottom of every page.
  footer: { desktop: 'leaderboard', mobile: 'mobileBanner', label: 'Advertisement' },
  // In-feed native, every few rows.
  feed: { native: true, label: 'Sponsored' },
};

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/**
 * The document served inside the sandboxed frame.
 *
 * `atOptions` has to be a global the invoke script can read, and it has to be
 * set before that script runs — which is exactly the inline-script pattern the
 * main document forbids. Confining it to this frame is the point: the inline
 * allowance exists here and nowhere else, and here there is no session to
 * steal.
 */
/**
 * The fill probe.
 *
 * An ad that never loads leaves a bordered grey rectangle labelled
 * ADVERTISEMENT, and a page full of those is the single loudest signal that
 * nobody actually looked at the thing. So the frame reports back: after giving
 * the tag time to render, it measures whether anything of substance landed and
 * posts the verdict to the parent, which collapses the slot to nothing if not.
 *
 * `postMessage` still works from a sandbox without `allow-same-origin` — the
 * frame simply has an opaque origin, so the parent authenticates the message by
 * matching `event.source` against the iframe's own contentWindow rather than by
 * checking `event.origin`.
 */
const PROBE = `
<script>
(function () {
  function filled() {
    // An unfilled tag leaves either nothing or a 1x1 tracking pixel.
    var nodes = document.body.querySelectorAll('iframe, img, ins, div');
    for (var i = 0; i < nodes.length; i++) {
      var r = nodes[i].getBoundingClientRect();
      if (r.width > 40 && r.height > 20) return true;
    }
    return false;
  }
  function report() {
    try { parent.postMessage({ afterdarkAd: filled() ? 'filled' : 'empty' }, '*'); } catch (e) {}
  }
  // Two looks: one when the tag has had a moment, one after a slow network.
  setTimeout(report, 1200);
  setTimeout(report, 3500);
})();
</script>`;

function frameHtml(slotName, variant) {
  const slot = SLOTS[slotName];
  if (!slot) return null;

  if (slot.native) {
    return `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}</style>
</head><body>
<div id="${NATIVE.container}"></div>
<script async data-cfasync="false" src="${NATIVE.script}"></script>
${PROBE}
</body></html>`;
  }

  const unitName = variant === 'mobile' ? (slot.mobile || slot.desktop) : slot.desktop;
  const unit = UNITS[unitName];
  if (!unit) return null;

  return `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}
body{display:flex;align-items:center;justify-content:center}</style>
</head><body>
<script type="text/javascript">
  atOptions = {
    'key' : '${unit.key}',
    'format' : 'iframe',
    'height' : ${unit.height},
    'width' : ${unit.width},
    'params' : {}
  };
</script>
<script type="text/javascript" src="${BANNER_HOST}/${unit.key}/invoke.js"></script>
${PROBE}
</body></html>`;
}

/**
 * Content-Security-Policy for the frame document. Deliberately narrow: the two
 * ad hosts, and the frames and images they need to render. Anything the tag
 * tries to load from elsewhere is refused.
 */
const FRAME_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' ${BANNER_HOST} ${NATIVE_HOST}`,
  "style-src 'unsafe-inline'",
  'img-src https: data:',
  'frame-src https:',
  `connect-src ${BANNER_HOST} ${NATIVE_HOST}`,
  "form-action 'none'",
].join('; ');

/** Geometry the client needs to reserve the box before anything loads. */
function slotMeta(name) {
  const slot = SLOTS[name];
  if (!slot) return null;
  if (slot.native) return { name, native: true, label: slot.label, height: NATIVE.height };
  const desktop = UNITS[slot.desktop];
  const mobile = slot.mobile ? UNITS[slot.mobile] : null;
  return {
    name,
    label: slot.label,
    desktop: { width: desktop.width, height: desktop.height },
    mobile: mobile ? { width: mobile.width, height: mobile.height } : null,
  };
}

const config = () => ({
  enabled: ENABLED,
  slots: Object.keys(SLOTS).map(slotMeta),
});

/** Express handler for `/ads/:slot`. */
function handler(req, res) {
  if (!ENABLED) return res.status(404).end();
  const variant = req.query.v === 'mobile' ? 'mobile' : 'desktop';
  const html = frameHtml(req.params.slot, variant);
  if (!html) return res.status(404).end();

  res.set({
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': FRAME_CSP,
    'X-Content-Type-Options': 'nosniff',
    // Referrer is what an ad network uses to fingerprint the reader's browsing.
    // Sending none costs targeting quality and is the right default here.
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'public, max-age=300',
  });
  res.end(html);
}

module.exports = { handler, config, slotMeta, frameHtml, SLOTS, UNITS, FRAME_CSP, ENABLED };
