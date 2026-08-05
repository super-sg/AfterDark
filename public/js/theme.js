/**
 * Theme bootstrap.
 *
 * Loaded synchronously in <head>, before the stylesheet, for one reason: if the
 * stored theme is applied after first paint the reader sees a white flash and
 * then the page goes dark, which looks broken. Setting the attribute before any
 * rendering happens costs a few hundred bytes and removes the flash entirely.
 *
 * A separate file rather than an inline <script> because the CSP is
 * `script-src 'self'` — no inline script anywhere, and that is worth keeping
 * more than this file is worth avoiding.
 *
 * First visit lands on dark. The palette is one electric accent against near-
 * black, and that accent only works there — the light theme keeps it as a fill
 * with dark ink rather than as text, which is a compromise, not the intent.
 * One click switches, and the choice is remembered from then on.
 */
(function () {
  var KEY = 'ad:theme';
  var theme = 'dark';
  try {
    var saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark') theme = saved;
  } catch (e) {
    /* private mode: dark it is */
  }
  document.documentElement.setAttribute('data-theme', theme);
})();
