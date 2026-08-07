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
 * Where ad frames are served from, and why it has to be somewhere else.
 *
 * The original design sandboxed each frame *without* `allow-same-origin`, so the
 * tag ran at an opaque origin and could touch neither the session cookie nor the
 * parent DOM. That part worked. What it also did was stop every banner from
 * rendering: an opaque origin makes `localStorage` throw, Adsterra's tag probes
 * for storage before it will serve, and a tag that finds none returns nothing.
 * Measured, not assumed -- identical frame, `allow-scripts allow-popups` gives
 * an empty box, adding `allow-same-origin` gives a 724x90 creative. Combined
 * with slots that collapse when unfilled, the failure was invisible: the site
 * looked deliberately ad-free while earning nothing.
 *
 * `allow-same-origin` on a frame served from our own host would hand ad script
 * the run of the site -- the session cookie is httpOnly, but same-origin script
 * can still call /api as the signed-in reader and read anything on the page.
 *
 * So the frame gets `allow-same-origin` and is served from a *different* origin.
 * It then has an origin of its own: localStorage works and the tag renders,
 * while the main site stays cross-origin and out of reach. This is the same
 * reason ad platforms serve their SafeFrames from a separate domain.
 *
 * Set ADS_ORIGIN to a second host pointing at this app (see render.yaml). Left
 * unset, ads are served same-origin and stay sandboxed -- safe, and empty.
 */
const ADS_ORIGIN = String(process.env.ADS_ORIGIN || '').trim().replace(/\/+$/, '');

/**
 * The escape hatch, off by default. Single-service deploys can trade the
 * isolation for working banners, but it must be typed out deliberately rather
 * than arrived at by accident.
 */
const UNSAFE_SAME_ORIGIN = process.env.ADS_ALLOW_SAME_ORIGIN === '1';

const SANDBOX = [
  'allow-scripts',
  'allow-popups',
  'allow-popups-to-escape-sandbox',
  ...(ADS_ORIGIN || UNSAFE_SAME_ORIGIN ? ['allow-same-origin'] : []),
].join(' ');

if (ENABLED && !ADS_ORIGIN && !UNSAFE_SAME_ORIGIN) {
  console.warn(
    '[ads] ADS_ORIGIN is not set, so ad frames stay at an opaque origin and'
    + ' banner tags will not fill. See the comment in src/ads.js.'
  );
}

/**
 * Publisher units. These are Adsterra banner tags: the page declares an
 * `atOptions` object and then loads the matching invoke script.
 */
const UNITS = {
  leaderboard: { key: 'f1e5e7079b5c4940c564196b07236884', width: 728, height: 90 },
  rectangle: { key: '2dce7e938b5a6c5ed772e4bf63f2e76b', width: 300, height: 250 },
  skyscraper: { key: 'b15c0ac6d8949dbf6e6e6b8f54faaca0', width: 160, height: 600 },
  mobileBanner: { key: 'cd4c2b0236320b682d8ee8ca10abfee0', width: 320, height: 50 },
  halfTower: { key: '8fcbbc5e27276cacc67255616e36ad44', width: 160, height: 300 },
  banner: { key: 'e308ee2af40bd02bb82dcb6c6b5788b4', width: 468, height: 60 },
};

/**
 * The "smart link" is a plain URL rather than a script, which makes it the one
 * high-yield format that needs no exception anywhere: it renders as an ordinary
 * anchor, styled as a sponsored tile, and the reader can see where it goes
 * before they click.
 */
const SMART_LINK = process.env.ADS_SMART_LINK
  || 'https://www.effectivecpmnetwork.com/eb1td9698?key=89d1af2c90f080c1f9bcbdf2e4a51d03';

/**
 * Pop-under. Off unless ADS_POPUNDER=1, and then capped at once per session.
 *
 * It works from inside the sandbox because the frame carries allow-popups, so
 * unlike the social bar it costs no architectural exception. What it costs is
 * retention: a pop-under is the format readers most reliably punish, and this
 * site's whole premise is people coming back to argue in the comments. Shipped
 * behind a flag so the choice is explicit rather than inherited.
 */
const POPUNDER = process.env.ADS_POPUNDER === '1'
  ? 'https://pl30723499.effectivecpmnetwork.com/a2/14/5a/a2145ad7b1da3787c6e8122370de8d23.js'
  : '';
// Only named in the frame CSP when the pop-under is actually switched on —
// a permitted host that nothing loads is a standing permission for no reason.
const POPUNDER_HOST = POPUNDER ? 'https://pl30723499.effectivecpmnetwork.com' : '';

const BANNER_HOST = 'https://www.highperformanceformat.com';

/**
 * How long the exit interstitial holds a reader before its Continue button
 * arms. Deployment decision rather than a constant: the right number is a
 * trade between what the placement earns and how many readers it costs, and
 * that can only be settled by watching the numbers on real traffic.
 *
 * Clamped at 15s. Past roughly that, an interstitial stops reading as a page
 * loading and starts reading as a site that has taken you hostage — and the
 * reader's response to that is a blocker, not a longer wait.
 */
const EXIT_WAIT = Math.min(15, Math.max(0, Number(process.env.ADS_EXIT_WAIT ?? 5) || 0));

/**
 * How often the same reader meets the interstitial.
 *
 *   once    (default) Once per destination host per session. The first click
 *           through to a given site is gated; later clicks to the same place go
 *           straight through.
 *   always  Every outbound click, without exception.
 *
 * `once` is the default because of who it protects. A reader passing through
 * gets the advert either way — the impression is not lost, only the repeats
 * are. What it spares is the person reading a thread and opening six links from
 * the same source, and that person is this site's whole premise: someone who
 * comes back to argue in the comments. `always` bills them thirty seconds for
 * one afternoon, and the reliable response to that is an ad blocker, after
 * which they are worth nothing at all.
 *
 * Set ADS_EXIT_MODE=always to gate every click regardless.
 */
const EXIT_MODE = process.env.ADS_EXIT_MODE === 'always' ? 'always' : 'once';

/**
 * Placements. Each names a desktop unit and, where the desktop one will not
 * fit, a narrow-screen replacement — a 728×90 leaderboard on a 390px phone is
 * a horizontal scrollbar, not an impression.
 */
const SLOTS = {
  // --- above the feed ------------------------------------------------------
  top: { desktop: 'leaderboard', mobile: 'mobileBanner', label: 'Advertisement' },
  boardHead: { desktop: 'banner', mobile: 'mobileBanner', label: 'Advertisement' },

  // --- right rail, interleaved between panels ------------------------------
  rail: { desktop: 'rectangle', mobile: null, label: 'Advertisement' },
  railMid: { desktop: 'rectangle', mobile: null, label: 'Advertisement' },
  railTall: { desktop: 'skyscraper', mobile: null, label: 'Advertisement' },

  // --- left rail, under the navigation -------------------------------------
  railLeft: { desktop: 'rectangle', mobile: null, label: 'Advertisement' },
  railLeftTall: { desktop: 'skyscraper', mobile: null, label: 'Advertisement' },
  railHalf: { desktop: 'halfTower', mobile: null, label: 'Advertisement' },

  // --- article page --------------------------------------------------------
  article: { desktop: 'banner', mobile: 'mobileBanner', label: 'Advertisement' },
  comments: { desktop: 'leaderboard', mobile: 'mobileBanner', label: 'Advertisement' },
  commentsMid: { desktop: 'banner', mobile: 'mobileBanner', label: 'Advertisement' },
  related: { desktop: 'banner', mobile: 'mobileBanner', label: 'Advertisement' },

  // --- index and listing pages ---------------------------------------------
  section: { desktop: 'banner', mobile: 'mobileBanner', label: 'Advertisement' },
  gridMid: { desktop: 'leaderboard', mobile: 'mobileBanner', label: 'Advertisement' },

  // --- infinite scroll: one between each appended page ---------------------
  page: { desktop: 'leaderboard', mobile: 'mobileBanner', label: 'Advertisement' },

  // --- navigation drawer ---------------------------------------------------
  drawerTop: { desktop: 'halfTower', mobile: 'mobileBanner', label: 'Advertisement' },
  drawerTall: { desktop: 'skyscraper', mobile: null, label: 'Advertisement' },

  // --- always present ------------------------------------------------------
  footer: { desktop: 'leaderboard', mobile: 'mobileBanner', label: 'Advertisement' },

  /**
   * The leaving-the-site interstitial. Two units, because this is the one
   * placement a reader is guaranteed to look at: they are waiting on it, so
   * the creative gets attention that an in-feed banner never does.
   *
   * Both are declared units at ordinary shapes. Nothing about the interstitial
   * needs a special tag — what makes it valuable is the dwell, not the format.
   */
  exitTop: { desktop: 'leaderboard', mobile: 'mobileBanner', label: 'Advertisement' },
  exitBox: { desktop: 'rectangle', mobile: 'rectangle', label: 'Advertisement' },

  // --- support page --------------------------------------------------------
  support: { desktop: 'banner', mobile: 'mobileBanner', label: 'Advertisement' },

  // In-feed, every few rows. This was a native-recommendation widget on a key
  // from an earlier batch, which is also the one unit that never filled once
  // the origin was fixed — most likely retired. Replaced with a declared unit
  // at a row-sized shape, so nothing here runs on a tag we were not given.
  feed: { desktop: 'banner', mobile: 'mobileBanner', label: 'Sponsored' },

  /**
   * Sticky bar, phones only. The highest-yielding unit on adult traffic and the
   * most intrusive, so it is dismissible and the dismissal sticks for the
   * session — a bar you cannot get rid of is the reason people install
   * blockers.
   */
  sticky: { desktop: null, mobile: 'mobileBanner', label: 'Advertisement', sticky: true },
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
  if (slotName === 'popunder') {
    if (!POPUNDER) return null;
    return `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script src="${POPUNDER}"></script>
</body></html>`;
  }

  const slot = SLOTS[slotName];
  if (!slot) return null;

  const unitName = variant === 'mobile' ? (slot.mobile || slot.desktop) : (slot.desktop || slot.mobile);
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
/**
 * Who may embed these frames. When ads move to their own host this is the only
 * thing standing between it and anyone framing our inventory into their page,
 * so it names the site rather than allowing all comers.
 */
const SITE_ORIGIN = String(process.env.SITE_ORIGIN || '').trim().replace(/\/+$/, '');

const FRAME_CSP = [
  `frame-ancestors 'self'${SITE_ORIGIN ? ` ${SITE_ORIGIN}` : ''}`,
  "default-src 'none'",
  `script-src 'unsafe-inline' ${BANNER_HOST}${POPUNDER_HOST ? ` ${POPUNDER_HOST}` : ''}`,
  "style-src 'unsafe-inline'",
  'img-src https: data:',
  'frame-src https:',
  `connect-src ${BANNER_HOST}${POPUNDER_HOST ? ` ${POPUNDER_HOST}` : ''}`,
  "form-action 'none'",
].join('; ');

/** Geometry the client needs to reserve the box before anything loads. */
function slotMeta(name) {
  const slot = SLOTS[name];
  if (!slot) return null;
  const desktop = slot.desktop ? UNITS[slot.desktop] : null;
  const mobile = slot.mobile ? UNITS[slot.mobile] : null;
  return {
    name,
    label: slot.label,
    sticky: !!slot.sticky,
    desktop: desktop ? { width: desktop.width, height: desktop.height } : null,
    mobile: mobile ? { width: mobile.width, height: mobile.height } : null,
  };
}

const config = () => ({
  enabled: ENABLED,
  slots: Object.keys(SLOTS).map(slotMeta),
  smartLink: SMART_LINK,
  popunder: !!POPUNDER,
  exitWait: EXIT_WAIT,
  exitMode: EXIT_MODE,
  // The client builds frame URLs and the sandbox attribute from these, so the
  // deployment decides the isolation model in one place instead of two.
  origin: ADS_ORIGIN,
  sandbox: SANDBOX,
});

/** Express handler for `/ads/:slot`. */
function handler(req, res) {
  if (!ENABLED) return res.status(404).end();
  const variant = req.query.v === 'mobile' ? 'mobile' : 'desktop';
  const html = frameHtml(req.params.slot, variant);
  if (!html) return res.status(404).end();

  // Helmet sets X-Frame-Options: SAMEORIGIN globally. That is right for every
  // other route and fatal here once the frames live on their own host, where
  // "same origin" is the ad host and not the site. frame-ancestors above is the
  // modern equivalent and is expressive enough to name the one site allowed.
  res.removeHeader('X-Frame-Options');

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

module.exports = {
  handler, config, slotMeta, frameHtml, SLOTS, UNITS, FRAME_CSP, ENABLED, SMART_LINK,
  ADS_ORIGIN, SANDBOX,
};
