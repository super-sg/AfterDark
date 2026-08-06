// Shared UI: toasts, modals, media, and the markup for posts and comment trees.

import {
  esc, attr, timeAgo, fullDate, num, markdown, plainText, avatarStyle, initials, hostOf,
} from './util.js';
import { icon, boardIcon } from './icons.js';

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

export function toast(message, kind = '') {
  const root = document.getElementById('toasts');
  const node = document.createElement('div');
  node.className = `toast${kind ? ` toast--${kind}` : ''}`;
  node.textContent = message;
  root.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .25s, transform .25s';
    node.style.opacity = '0';
    node.style.transform = 'translateY(8px)';
    setTimeout(() => node.remove(), 260);
  }, 4200);
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

let closeActiveModal = null;

export function openModal(innerHtml, { onMount, wide = false } = {}) {
  closeModal();
  const root = document.getElementById('modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="modal${wide ? ' modal--wide' : ''}" role="dialog" aria-modal="true">${innerHtml}</div>`;
  root.append(backdrop);
  document.body.style.overflow = 'hidden';

  const previouslyFocused = document.activeElement;
  const panel = backdrop.querySelector('.modal');

  const onKey = (e) => {
    if (e.key === 'Escape') closeModal();
  };
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) closeModal();
  });
  document.addEventListener('keydown', onKey);

  closeActiveModal = () => {
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
    document.body.style.overflow = '';
    closeActiveModal = null;
    if (previouslyFocused?.focus) previouslyFocused.focus();
  };

  panel.querySelector('[data-close]')?.addEventListener('click', closeModal);
  onMount?.(panel);
  panel.querySelector('input, textarea, button:not([data-close])')?.focus();
  return panel;
}

export function closeModal() {
  closeActiveModal?.();
}

export const isModalOpen = () => closeActiveModal !== null;

// ---------------------------------------------------------------------------
// Voting
// ---------------------------------------------------------------------------

/** Horizontal pill — card and compact views. */
export function votePill(item, type = 'post') {
  const state = item.myVote === 1 ? 'up' : item.myVote === -1 ? 'down' : '';
  return `
    <span class="votepill" data-vote-group data-type="${type}" data-id="${item.id}">
      <button class="vote-btn" data-vote="1" data-active="${item.myVote === 1 ? 'up' : ''}"
              aria-label="Upvote" aria-pressed="${item.myVote === 1}">${icon('voteUp')}</button>
      <span class="vote-score" data-score data-state="${state}">${num(item.score)}</span>
      <button class="vote-btn" data-vote="-1" data-active="${item.myVote === -1 ? 'down' : ''}"
              aria-label="Downvote" aria-pressed="${item.myVote === -1}">${icon('voteDown')}</button>
    </span>`;
}

/** Vertical column — classic view and the post page. */
export function voteColumn(item, type = 'post') {
  const state = item.myVote === 1 ? 'up' : item.myVote === -1 ? 'down' : '';
  return `
    <div class="votes" data-vote-group data-type="${type}" data-id="${item.id}">
      <button class="vote-btn" data-vote="1" data-active="${item.myVote === 1 ? 'up' : ''}"
              aria-label="Upvote" aria-pressed="${item.myVote === 1}">${icon('voteUp')}</button>
      <span class="vote-score" data-score data-state="${state}">${num(item.score)}</span>
      <button class="vote-btn" data-vote="-1" data-active="${item.myVote === -1 ? 'down' : ''}"
              aria-label="Downvote" aria-pressed="${item.myVote === -1}">${icon('voteDown')}</button>
    </div>`;
}

function inlineVote(item) {
  const state = item.myVote === 1 ? 'up' : item.myVote === -1 ? 'down' : '';
  return `
    <span class="comment__vote" data-vote-group data-type="comment" data-id="${item.id}">
      <button class="vote-btn" data-vote="1" data-active="${item.myVote === 1 ? 'up' : ''}"
              aria-label="Upvote" aria-pressed="${item.myVote === 1}">${icon('voteUp')}</button>
      <span class="comment__score" data-score data-state="${state}">${num(item.score)}</span>
      <button class="vote-btn" data-vote="-1" data-active="${item.myVote === -1 ? 'down' : ''}"
              aria-label="Downvote" aria-pressed="${item.myVote === -1}">${icon('voteDown')}</button>
    </span>`;
}

export function paintVote(group, { score, value }) {
  const scoreEl = group.querySelector('[data-score]');
  if (scoreEl) {
    scoreEl.textContent = num(score);
    scoreEl.dataset.state = value === 1 ? 'up' : value === -1 ? 'down' : '';
  }
  group.querySelectorAll('[data-vote]').forEach((btn) => {
    const own = Number(btn.dataset.vote);
    const active = own === value;
    btn.dataset.active = active ? (own === 1 ? 'up' : 'down') : '';
    btn.setAttribute('aria-pressed', String(active));
  });
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

/**
 * Every card gets a picture. If the post has no image of its own, a cover is
 * generated from its id — deterministic, so a thread always looks like itself,
 * and the feed never has a ragged hole where an image should be.
 */
function generatedCover(post, { glyphSize = 46 } = {}) {
  let hash = 0;
  const key = `${post.id}:${post.title}`;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  const hue2 = (hue + 40 + (hash >> 8) % 60) % 360;
  const angle = 95 + ((hash >> 16) % 60);

  // Only the hues come from here. Saturation and lightness are theme tokens,
  // so the same cover is a deep jewel tone on dark and a pale wash on light —
  // a fixed 26%-lightness square would be a hole punched in a light page.
  const style = [
    `--h1:${hue}`,
    `--h2:${hue2}`,
    `--angle:${angle}deg`,
  ].join(';');

  return `<div class="cover" style="${attr(style)}">
      <span class="cover__glyph">${boardIcon(post.board?.slug, { size: glyphSize })}</span>
    </div>`;
}

// ---------------------------------------------------------------------------
// Explicit-media gate
//
// The site is adults-only, which settles whether a reader may see explicit
// artwork — not whether it should arrive unannounced in a scrolling feed. So
// explicit thumbnails render blurred with a one-click reveal, the choice sticks
// for the session, and a preference makes it stick for good.
//
// Both renditions ship with the payload, so revealing is instant rather than a
// round trip. The gate exists to stop an ambush, not to keep a secret from an
// adult who has already asked to be here.
// ---------------------------------------------------------------------------

const REVEAL_KEY = 'ad:reveal';
const revealedThisSession = new Set();

/**
 * Explicit thumbnails are shown by default.
 *
 * Blur-by-default was right when the age gate was the only signal we had: a
 * reader could land here without having said anything about themselves. That
 * is no longer true — the interstitial is confirmed, the boards are labelled,
 * and the person is on an adult site on purpose. Making them click twice for
 * every picture treats a decision they already made as if it were an accident.
 *
 * The toggle stays, and it stays honoured: anyone who turns blurring on gets it
 * everywhere and it follows their account. Absent a stored preference, the
 * default matches what the site is.
 */
export const revealsAll = () => {
  try {
    const stored = localStorage.getItem(REVEAL_KEY);
    return stored === null ? true : stored === '1';
  } catch {
    return true;
  }
};

/** Persist the reader's choice. Also written by the Settings page. */
export function setRevealAll(on) {
  try { localStorage.setItem(REVEAL_KEY, on ? '1' : '0'); } catch { /* private mode */ }
}

export const isRevealed = (post) => !post.nsfw || revealsAll() || revealedThisSession.has(post.id);
export const rememberReveal = (id) => revealedThisSession.add(id);

/** `4213` → `1:10:13`, `95` → `1:35`. */
export function runtime(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (!s) return '';
  const parts = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60];
  return (parts[0] ? parts : parts.slice(1))
    .map((n, i) => (i === 0 ? String(n) : String(n).padStart(2, '0')))
    .join(':');
}

/**
 * @param {object} post
 * @param {'thumb'|'card'|'wide'|'hero'} size
 */
export function media(post, size = 'card', { className = '' } = {}) {
  const sharp = post.img?.[size] || '';
  const blur = post.imgBlur?.[size] || '';
  const gated = !!post.nsfw && !!blur && !isRevealed(post);
  const src = gated ? blur : sharp;

  const tint = post.tint ? `--tint:${post.tint}` : '';
  const cls = `media${post.videoKind ? ' media--video' : ''}${gated ? ' media--gated' : ''}${className ? ` ${className}` : ''}`;

  // No inline onload handler: the CSP forbids inline script, so the fade-in is
  // driven by a capturing 'load' listener in app.js. `data-sharp` carries the
  // unblurred URL so revealing is a src swap rather than a refetch of the page.
  const inner = src
    ? `<img src="${attr(src)}" alt="${attr(gated ? 'Hidden explicit image' : post.imageAlt || '')}"
            loading="lazy" decoding="async" data-loaded="false"
            ${sharp ? `data-sharp="${attr(sharp)}"` : ''} />`
    : generatedCover(post, { glyphSize: size === 'thumb' ? 26 : 46 });

  const gate = gated
    ? `<button class="media__gate" data-reveal="${post.id}" aria-label="Show explicit image">
         <span class="media__gate-icon">${icon('eye', { size: 20 })}</span>
         <span class="media__gate-label">Explicit — tap to view</span>
       </button>`
    : '';

  const play = post.videoKind && !gated
    ? `<button class="media__play" data-play="${attr(post.videoKind)}" data-video="${attr(post.videoId)}"
               aria-label="Play video">
         <span class="media__play-btn">${icon('play', { size: 30 })}</span>
       </button>
       <span class="media__badge">${icon('video', { size: 13 })} ${esc(post.videoKind === 'youtube' ? 'YouTube' : 'Vimeo')}</span>`
    : '';

  const length = post.duration ? `<span class="media__runtime">${esc(runtime(post.duration))}</span>` : '';

  return `<div class="${cls}" style="${attr(tint)}">${inner}${play}${gate}${length}</div>`;
}

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

export const REACTIONS = ['🔥', '💀', '👀', '🤝', '🧠', '😂'];

/**
 * The low-effort contribution. Most readers will never write a comment; a
 * reaction is one tap, so it is the thing they will actually do — and unlike a
 * vote it says *what* they thought, without moving the post up the page.
 */
export function reactionBar(post, { compact = false } = {}) {
  const counts = post.reactions || {};
  const mine = new Set(post.myReactions || []);
  const used = REACTIONS.filter((e) => counts[e] > 0);
  // Collapsed until someone starts: an empty row of six emoji on every card is
  // clutter, but one already in use is an invitation.
  const shown = used.length ? used : [];

  return `<div class="reactions${compact ? ' reactions--compact' : ''}" data-reactions="${post.id}">
    ${shown.map((emoji) => `
      <button class="reaction${mine.has(emoji) ? ' reaction--mine' : ''}" data-react="${attr(emoji)}"
              aria-pressed="${mine.has(emoji)}" title="React">
        <span class="reaction__emoji">${emoji}</span><span class="reaction__n">${counts[emoji]}</span>
      </button>`).join('')}
    <button class="reaction reaction--add" data-react-open aria-label="Add a reaction">
      ${icon('smile', { size: 15 })}
    </button>
  </div>`;
}

export function reactionPicker() {
  return `<div class="react-picker" role="menu">
    ${REACTIONS.map((e) => `<button class="react-picker__btn" data-react="${attr(e)}" role="menuitem">${e}</button>`).join('')}
  </div>`;
}

/** Repaint one post's reaction row in place after the server answers. */
export function paintReactions(root, post) {
  const bar = root.querySelector(`[data-reactions="${post.id}"]`);
  if (bar) bar.outerHTML = reactionBar(post);
}

// ---------------------------------------------------------------------------
// Ad slots
//
// Each slot reserves its exact declared size before anything loads. An ad that
// arrives late and shoves the page down is the biggest single source of layout
// shift on an ad-supported site, and it is also how a reader loses their place
// mid-sentence — which matters more here than the impression does.
//
// The frame is sandboxed without `allow-same-origin`, so the tag inside runs at
// an opaque origin: it can render and it can open its click-through, but it
// cannot read the session cookie or touch the parent document.
// ---------------------------------------------------------------------------

let adConfig = { enabled: false, slots: [] };

/**
 * Preview mode: draw every slot as a labelled outline whether or not it filled.
 *
 * Slots collapse to nothing when unsold, which is right for readers and
 * useless for whoever has to check the placements. ?ads=preview turns it on
 * for the tab, ?ads=off clears it. Nothing reaches the server and it cannot
 * change what a real visitor sees.
 */
const PREVIEW_KEY = 'ad:preview';

export function initAdPreview() {
  const flag = new URLSearchParams(location.search).get('ads');
  try {
    if (flag === 'preview') sessionStorage.setItem(PREVIEW_KEY, '1');
    if (flag === 'off') sessionStorage.removeItem(PREVIEW_KEY);
  } catch { /* private mode */ }
}

const previewing = () => {
  try { return sessionStorage.getItem(PREVIEW_KEY) === '1'; } catch { return false; }
};

/** Slots the reader has closed. Session-scoped: a fresh visit gets them back. */
const dismissed = new Set();
export const dismissAd = (name) => dismissed.add(name);
export const setAdConfig = (cfg) => { adConfig = cfg || { enabled: false, slots: [] }; };

const SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox';

/**
 * A slot starts collapsed and only takes space once the frame reports that a
 * real creative landed. That inverts the usual trade-off: reserving the box up
 * front avoids layout shift but leaves a grey rectangle on every page where the
 * network is blocked or the inventory is unsold — and a page of those is the
 * loudest possible signal that nobody looked at it.
 *
 * The compromise is that the expansion is animated over 160ms rather than
 * snapping, so a late fill reads as the page settling rather than jumping.
 */
export function adSlot(name, { className = '' } = {}) {
  if (!adConfig.enabled) return '';
  if (dismissed.has(name)) return '';
  const meta = adConfig.slots.find((s) => s.name === name);
  if (!meta) return '';

  const mobile = window.matchMedia('(max-width: 760px)').matches;
  // Slots can be one-sided: the rails have no phone unit, the sticky bar has no
  // desktop one. Rendering the wrong side is a horizontal scrollbar, not an
  // impression.
  if (!meta.native && mobile && !meta.mobile) return '';
  if (!meta.native && !mobile && !meta.desktop) return '';

  const box = meta.native ? { width: 0, height: meta.height } : ((mobile && meta.mobile) || meta.desktop || meta.mobile);
  const size = meta.native ? `--ad-h:${box.height}px` : `--ad-w:${box.width}px;--ad-h:${box.height}px`;

  if (previewing()) {
    return `<aside class="adslot adslot--preview${className ? ` ${className}` : ''}"
                   style="${attr(size)}" data-adslot="${attr(name)}" data-state="filled">
      <span class="adslot__ghost">
        <b>${esc(name)}</b>
        <span>${esc(meta.native ? 'native · fluid' : `${box.width}×${box.height}`)}</span>
      </span>
    </aside>`;
  }

  return `<aside class="adslot${meta.native ? ' adslot--native' : ''}${className ? ` ${className}` : ''}"
                 style="${attr(size)}" data-adslot="${attr(name)}" aria-hidden="true">
    <iframe class="adslot__frame" src="/ads/${attr(name)}${mobile && meta.mobile ? '?v=mobile' : ''}"
            title="${attr(meta.label)}" loading="lazy" scrolling="no"
            sandbox="${SANDBOX}" referrerpolicy="no-referrer"
            ${meta.native ? '' : `width="${box.width}" height="${box.height}"`}></iframe>
    ${meta.sticky
      ? `<button class="adslot__close" data-ad-dismiss aria-label="Hide this advert">${icon('close', { size: 14 })}</button>`
      : `<span class="adslot__label">${esc(meta.label)}</span>`}
  </aside>`;
}

/**
 * Listen for the frame's verdict. Authenticated by matching event.source to a
 * known iframe — the frames run at an opaque origin, so event.origin is "null"
 * and cannot be checked.
 */
export function watchAdSlots() {
  window.addEventListener('message', (event) => {
    const verdict = event.data?.afterdarkAd;
    if (verdict !== 'filled' && verdict !== 'empty') return;
    for (const slot of document.querySelectorAll('[data-adslot]')) {
      const frame = slot.querySelector('iframe');
      if (frame && frame.contentWindow === event.source) {
        slot.dataset.state = verdict;
        return;
      }
    }
  });
}

export function interleaveAds(items, every = 4) {
  if (!adConfig.enabled || items.length <= every) return null;
  const marks = [];
  for (let i = every; i < items.length; i += every) marks.push(i);
  return marks;
}

// ---------------------------------------------------------------------------
// Awards
//
// Shown only where one has been given. An empty award row on every post is a
// permanent advert for a feature nobody has used yet.
// ---------------------------------------------------------------------------

export function awardRibbon(post) {
  const list = post.awards || [];
  if (!list.length) return '';
  return `<span class="awards">${list.map((a) => `
    <span class="award" title="${attr(`${a.label} — ${a.blurb}`)}">
      <span class="award__emoji">${a.emoji}</span>${a.count > 1 ? `<span class="award__n">${a.count}</span>` : ''}
    </span>`).join('')}</span>`;
}

export function awardPicker(catalogue, remaining) {
  return `<div class="award-picker" role="menu">
    <p class="award-picker__head">${remaining} left this month</p>
    ${catalogue.map((a) => `
      <button class="award-picker__row" data-give-award="${attr(a.slug)}" role="menuitem" ${remaining ? '' : 'disabled'}>
        <span class="award-picker__emoji">${a.emoji}</span>
        <span><b>${esc(a.label)}</b><span>${esc(a.blurb)}</span></span>
      </button>`).join('')}
  </div>`;
}

// ---------------------------------------------------------------------------
// Topics
// ---------------------------------------------------------------------------

export function topicChips(post, limit = 3) {
  const list = (post.topics || []).slice(0, limit);
  if (!list.length) return '';
  return `<div class="topics">${list
    .map((t) => `<a class="topic" href="/t/${attr(t.slug)}" data-link>${esc(t.label)}</a>`)
    .join('')}</div>`;
}

/** Swap a facade for the real player. Only ever called from a click. */
export function playVideo(container, kind, id) {
  const src = kind === 'vimeo'
    ? `https://player.vimeo.com/video/${encodeURIComponent(id)}?autoplay=1&dnt=1`
    : `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&rel=0&modestbranding=1`;

  const frame = document.createElement('iframe');
  frame.src = src;
  frame.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture';
  frame.allowFullscreen = true;
  frame.title = 'Embedded video';
  frame.referrerPolicy = 'strict-origin-when-cross-origin';
  container.querySelector('.media__play')?.remove();
  container.querySelector('.media__badge')?.remove();
  container.append(frame);
}

// ---------------------------------------------------------------------------
// Badges & bylines
// ---------------------------------------------------------------------------

function roleBadge(role) {
  if (role === 'admin') return '<span class="badge badge--admin">admin</span>';
  if (role === 'mod') return '<span class="badge badge--mod">staff</span>';
  return '';
}

function flairChip(post) {
  if (!post.flair) return '';
  const modifier = post.flair === 'Wire' ? ' flair--wire' : post.board.kind === 'news' ? ' flair--news' : '';
  return `<span class="flair${modifier}">${esc(post.flair)}</span>`;
}

function boardPill(post) {
  return `<a class="post__board" href="/b/${attr(post.board.slug)}" data-link
             style="--board-accent:${attr(post.board.accent)}">
            ${boardIcon(post.board.slug, { size: 14 })}${esc(post.board.name)}
          </a>`;
}

function byline(post) {
  if (!post.author || post.author === '[deleted]') {
    return `<span class="source-pill">${esc(post.source || 'AfterDark Wire')}</span>`;
  }
  return `<a class="post__author" href="/u/${attr(post.author)}" data-link>${esc(post.author)}</a>${roleBadge(post.authorRole)}`;
}

const stampOf = (post) => (post.kind === 'article' && post.publishedAt ? post.publishedAt : post.createdAt);

// ---------------------------------------------------------------------------
// Post card
// ---------------------------------------------------------------------------

export function postCard(post, { showBoard = true, view = 'card' } = {}) {
  const stamp = stampOf(post);

  // A picture is shown when there is one. The previous build generated a
  // gradient square for every text post, which cost 130px a row and told the
  // reader nothing — X omits the slot entirely and the feed gets denser for it.
  const hasMedia = !!(post.img || post.videoKind);

  // A banner is earned only by a video, where the play target *is* the post.
  // Everything else gets a side thumbnail with an expand control — Reddit's
  // expando, and the single reason its feed fits eight items on a screen where
  // a banner-per-item fits two.
  const banner = hasMedia && view === 'card' && !!post.videoKind;
  const mediaSize = banner ? 'card' : 'thumb';

  const outbound = (post.kind === 'article' && post.sourceUrl) || (post.kind === 'link' && post.url);
  const source = outbound
    ? `<a class="post__source" href="${attr(post.sourceUrl || post.url)}" rel="noopener nofollow ugc" target="_blank">
         ${esc(hostOf(post.sourceUrl || post.url))}${icon('externalLink', { size: 11 })}
       </a>`
    : '';

  // The thumbnail is a button, not a link: it expands the picture in place
  // rather than navigating, so a reader can look without losing their scroll
  // position. `data-card` carries the larger rendition for the swap.
  const mediaBlock = !hasMedia
    ? ''
    : banner
      ? `<a class="post__media" href="/p/${post.id}" data-link tabindex="-1" aria-hidden="true">${media(post, mediaSize)}</a>`
      : `<button class="post__media" data-expand="${post.id}"
                 data-card="${attr(post.img?.card || '')}"
                 aria-expanded="false" aria-label="Expand image">
           ${media(post, 'thumb')}
           <span class="post__expand">${icon('plus', { size: 13 })}</span>
         </button>`;

  const identity = `<a class="post__avatar" href="/b/${attr(post.board.slug)}" data-link tabindex="-1"
                       style="--board-accent:${attr(post.board.accent)}" aria-hidden="true"
                    >${boardIcon(post.board.slug, { size: 18 })}</a>`;

  const head = `
    <div class="post__head">
      ${showBoard
        ? `<a class="post__board" href="/b/${attr(post.board.slug)}" data-link>${esc(post.board.name)}</a><span class="post__dot">·</span>`
        : ''}
      ${byline(post)}
      <span class="post__dot">·</span>
      <time datetime="${new Date(stamp).toISOString()}" title="${attr(fullDate(stamp))}">${timeAgo(stamp)}</time>
      ${source}
      ${post.pinned ? '<span class="flair">Pinned</span>' : ''}
      ${flairChip(post)}
      ${post.removed ? '<span class="badge badge--removed">removed</span>' : ''}
      ${awardRibbon(post)}
    </div>`;

  const main = `
    <div class="post__main">
      ${head}
      <h2 class="post__title"><a href="/p/${post.id}" data-link>${esc(post.title)}</a></h2>
      ${post.excerpt && view === 'card'
        ? `<p class="post__excerpt">${esc(plainText(post.excerpt))}${post.truncated ? '…' : ''}</p>`
        : ''}
      ${view === 'compact' ? '' : topicChips(post, 2)}
      ${banner ? mediaBlock : ''}

      <div class="post__actions">
        ${view === 'classic' ? '' : votePill(post)}
        <a class="action" href="/p/${post.id}" data-link>
          ${icon('comment', { size: 16 })} ${num(post.commentCount)}
        </a>
        <button class="action" data-save="${post.id}" data-on="${post.saved ? 'true' : 'false'}"
                aria-pressed="${!!post.saved}" title="Save for later">
          ${icon('bookmark', { size: 16 })} <span class="btn-label">${post.saved ? 'Saved' : 'Save'}</span>
        </button>
        <button class="action" data-share="${post.id}">${icon('share', { size: 16 })} <span class="btn-label">Share</span></button>
        <button class="action award-btn" data-award-open="${post.id}" aria-label="Give an award" title="Give an award">${icon('star', { size: 16 })}</button>
        <button class="action" data-report-post="${post.id}" aria-label="Report">${icon('flag', { size: 16 })}</button>
        ${view === 'compact' ? '' : reactionBar(post)}
      </div>
    </div>`;

  const classes = [
    'post',
    post.pinned ? 'post--pinned' : '',
    hasMedia && !banner ? 'post--thumb' : '',
  ].filter(Boolean).join(' ');

  const side = banner ? '' : mediaBlock;

  if (view === 'classic') {
    return `<article class="${classes}" data-post-id="${post.id}">
      ${voteColumn(post)}${identity}${main}${side}
    </article>`;
  }

  return `<article class="${classes}" data-post-id="${post.id}">
    ${identity}${main}${side}
  </article>`;
}

/**
 * Media-first tile for the video boards.
 *
 * A trending-video listing is a shelf, not a thread list: the picture is the
 * headline, and runtime and view count are what a reader actually compares. The
 * thumbnail links out to the publisher; the title links to our discussion of
 * it — the two things a reader wants are never the same click.
 */
export function videoTile(post) {
  const out = post.url || post.sourceUrl;
  return `<article class="tile" data-post-id="${post.id}">
    <a class="tile__media" href="${attr(out)}" rel="noopener nofollow ugc" target="_blank"
       aria-label="Watch on ${attr(post.source || hostOf(out))}">
      ${media(post, 'card')}
      <span class="tile__watch">${icon('play', { size: 15 })} Watch on ${esc(post.source || hostOf(out))}</span>
    </a>
    <div class="tile__body">
      <h3 class="tile__title"><a href="/p/${post.id}" data-link>${esc(post.title)}</a></h3>
      <div class="tile__stats">
        ${post.views ? `<span title="Views reported by the publisher">${icon('eye', { size: 13 })} ${num(post.views)}</span>` : ''}
        ${post.duration ? `<span>${icon('clock', { size: 13 })} ${esc(runtime(post.duration))}</span>` : ''}
        <time>${timeAgo(stampOf(post))}</time>
      </div>
      ${topicChips(post, 2)}
      <div class="tile__actions">
        ${votePill(post)}
        <a class="action" href="/p/${post.id}" data-link>${icon('comment', { size: 15 })} ${num(post.commentCount)}</a>
        <button class="action" data-save="${post.id}" data-on="${post.saved ? 'true' : 'false'}"
                aria-pressed="${!!post.saved}">${icon('bookmark', { size: 15 })}</button>
        ${reactionBar(post, { compact: true })}
      </div>
    </div>
  </article>`;
}

export function feedList(items, options = {}) {
  if (!items.length) return '';
  const view = options.view || 'card';
  const render = view === 'theatre' ? videoTile : (p) => postCard(p, options);

  // In-feed slots are opt-in per call site, so the newsroom hero and the
  // "more from this board" strip stay clean.
  const marks = options.ads === false ? null : interleaveAds(items);
  const body = items
    .map((p, i) => (marks && marks.includes(i) ? adSlot('feed', { className: 'adslot--feed' }) : '') + render(p))
    .join('');

  return `<div class="feed feed--${view}">${body}</div>`;
}


// ---------------------------------------------------------------------------
// Newsroom pieces
// ---------------------------------------------------------------------------

export function newsLead(post) {
  const stamp = stampOf(post);
  return `<a class="newslead" href="/p/${post.id}" data-link>
    ${media(post, 'hero')}
    <div class="newslead__body">
      <div class="post__meta">
        ${boardPill(post)}
        ${byline(post)}
        <span>·</span>
        <time>${timeAgo(stamp)}</time>
        ${post.readingMinutes && post.kind === 'text' ? `<span>· ${post.readingMinutes} min read</span>` : ''}
      </div>
      <h2>${esc(post.title)}</h2>
      ${post.excerpt ? `<p>${esc(plainText(post.excerpt))}</p>` : ''}
      <div class="post__actions">
        ${votePill(post)}
        <span class="action">${icon('comment', { size: 16 })} ${num(post.commentCount)}</span>
        <button class="action" data-save="${post.id}" data-on="${post.saved ? 'true' : 'false'}">
          ${icon('bookmark', { size: 16 })} <span class="btn-label">${post.saved ? 'Saved' : 'Save'}</span>
        </button>
      </div>
    </div>
  </a>`;
}

export function newsCard(post) {
  const stamp = stampOf(post);
  return `<a class="newscard" href="/p/${post.id}" data-link>
    ${media(post, 'card')}
    <div class="newscard__body">
      <span class="source-pill">${esc(post.source || post.board.name)}</span>
      <h3>${esc(post.title)}</h3>
      <div class="newscard__foot">
        <time>${timeAgo(stamp)}</time>
        <span>·</span>
        <span>${num(post.commentCount)} comments</span>
      </div>
    </div>
  </a>`;
}

export function newsGrid(items) {
  if (!items.length) return '';
  return `<div class="newsgrid">${items.map(newsCard).join('')}</div>`;
}

export function sectionHead(title, iconName = 'newspaper') {
  return `<div class="section-head">
    ${icon(iconName, { size: 18 })}<h2>${esc(title)}</h2><span class="section-head__rule"></span>
  </div>`;
}

// ---------------------------------------------------------------------------
// Comment tree
// ---------------------------------------------------------------------------

export function commentTree(nodes, opAuthor) {
  if (!nodes.length) {
    return `<div class="empty"><h2>No comments yet</h2><p>Be the first to say something worth reading.</p></div>`;
  }
  return nodes.map((n) => commentNode(n, opAuthor)).join('');
}

function commentNode(node, opAuthor) {
  const isOp = node.author === opAuthor;
  const body = node.removed ? '<p><em>Removed by a moderator.</em></p>' : markdown(node.body);

  return `
  <div class="comment${node.removed ? ' comment--removed' : ''}" data-comment-id="${node.id}"
       data-raw="${attr(node.body)}">
    <div class="comment__row">
      <div class="comment__gutter">
        <div class="comment__avatar" style="${attr(avatarStyle(node.author))}" aria-hidden="true">${esc(initials(node.author))}</div>
        ${node.replies.length
          ? '<button class="comment__thread-line" data-collapse aria-label="Collapse thread"></button>'
          : ''}
      </div>
      <div>
        <div class="comment__meta">
          <button class="comment__toggle" data-collapse hidden>+</button>
          <a class="comment__author${isOp ? ' comment__author--op' : ''}" href="/u/${attr(node.author)}" data-link>${esc(node.author)}</a>
          ${roleBadge(node.authorRole)}
          ${isOp ? '<span class="badge badge--mod">OP</span>' : ''}
          <span>·</span>
          <time title="${attr(fullDate(node.createdAt))}">${timeAgo(node.createdAt)}</time>
          ${node.editedAt ? '<span>· edited</span>' : ''}
        </div>
        <div class="comment__text prose">${body}</div>
        <div class="comment__actions">
          ${inlineVote(node)}
          <button class="action" data-reply="${node.id}">${icon('comment', { size: 15 })} Reply</button>
          ${node.canEdit ? `<button class="action" data-edit-comment="${node.id}">${icon('edit', { size: 15 })}</button>` : ''}
          ${node.canEdit ? `<button class="action" data-delete-comment="${node.id}">${icon('trash', { size: 15 })}</button>` : ''}
          <button class="action" data-report-comment="${node.id}">${icon('flag', { size: 15 })}</button>
        </div>
        <div data-reply-slot></div>
      </div>
    </div>
    ${node.replies.length ? `<div class="comment__children">${node.replies.map((r) => commentNode(r, opAuthor)).join('')}</div>` : ''}
  </div>`;
}

// ---------------------------------------------------------------------------
// Reusable fragments
// ---------------------------------------------------------------------------

export function skeleton(rows = 4) {
  return `<div class="skeleton">${'<div class="skeleton__row"></div>'.repeat(rows)}</div>`;
}

export function emptyState(title, message, actionHtml = '') {
  return `<div class="empty"><h2>${esc(title)}</h2><p>${esc(message)}</p>${actionHtml}</div>`;
}

export function errorState(message) {
  return `<div class="empty"><h2>That did not work</h2><p>${esc(message)}</p>
    <button class="btn" data-reload>Reload</button></div>`;
}

export { icon, boardIcon };
