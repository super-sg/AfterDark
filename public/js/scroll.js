// Scroll behaviour: reveal-on-enter, and a top bar that gets out of the way.
//
// Two effects, both cheap. Everything is driven by IntersectionObserver and a
// single passive scroll listener rather than by measuring layout on every
// frame — a feed can hold hundreds of rows, and anything that reads offsetTop
// per scroll event will jank on the first long session.

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

/**
 * Rows rise a few pixels as they come into view. Deliberately restrained: a
 * long slide on every post is nauseating by the fifth screen, and this has to
 * survive infinite scroll.
 *
 * The attribute is `data-enter`, not `data-reveal`: the click handler in
 * app.js owns `[data-reveal]` for the explicit-image gate, and stamping the
 * same name on every post made `target.closest('[data-reveal]')` match the
 * whole card — so every click anywhere in a post was swallowed by the gate
 * branch and no post ever opened.
 */
let revealObserver = null;

export function observeReveals(root = document) {
  if (reduced.matches) return;

  if (!revealObserver) {
    revealObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.dataset.entered = 'true';
        revealObserver.unobserve(entry.target);
      }
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.02 });
  }

  for (const el of root.querySelectorAll('.post:not([data-enter]), .comm:not([data-enter]), .tile:not([data-enter]), .newscard:not([data-enter])')) {
    el.dataset.enter = 'true';
    revealObserver.observe(el);
  }
}

/**
 * The top bar hides on the way down and returns on the way up — the phone-app
 * convention, and worth ~58px of reading height on a feed. It always returns at
 * the very top, and never hides while a menu or modal has the page locked.
 */
export function watchTopbar() {
  const bar = document.querySelector('.topbar');
  if (!bar || reduced.matches) return;

  let last = window.scrollY;
  let ticking = false;

  const update = () => {
    const y = Math.max(0, window.scrollY);
    const delta = y - last;

    // Ignore rubber-banding and sub-pixel noise.
    if (Math.abs(delta) > 6 && !document.body.classList.contains('nav-open')) {
      bar.dataset.hidden = delta > 0 && y > 160 ? 'true' : 'false';
      last = y;
    }
    bar.dataset.stuck = y > 8 ? 'true' : 'false';
    ticking = false;
  };

  window.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(update);
  }, { passive: true });

  update();
}

/** Reading progress on an article page. Nothing to compute when there is none. */
export function watchReadingProgress() {
  const bar = document.getElementById('read-progress');
  const article = document.querySelector('.detail');
  if (!bar) return;

  if (!article) {
    bar.style.transform = 'scaleX(0)';
    return;
  }

  const update = () => {
    const box = article.getBoundingClientRect();
    const total = box.height - window.innerHeight;
    const done = total > 0 ? Math.min(1, Math.max(0, -box.top / total)) : 0;
    bar.style.transform = `scaleX(${done})`;
  };

  update();
  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update, { passive: true });
}
