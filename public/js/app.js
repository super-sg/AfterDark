// AfterDark client: router, views and event delegation.

import { api, query, ApiError } from './api.js';
import {
  esc, attr, timeAgo, fullDate, num, markdown, plainText, avatarStyle, initials, hostOf, debounce, qs,
} from './util.js';
import {
  toast, openModal, closeModal, isModalOpen, voteColumn, votePill, paintVote,
  postCard, feedList, commentTree, media, playVideo, newsLead, newsGrid, sectionHead,
  skeleton, emptyState, errorState, reactionBar, reactionPicker, topicChips,
  revealsAll, setRevealAll, rememberReveal, runtime, adSlot, setAdConfig, watchAdSlots, dismissAd,
  awardRibbon, awardPicker,
} from './ui.js';
import { icon, boardIcon } from './icons.js';
import { observeReveals, watchTopbar, watchReadingProgress } from './scroll.js';

const VIEWS = ['card', 'compact', 'classic'];

// Boards whose content is a shelf of clips rather than a list of threads get a
// media-first grid. It is not a user preference — it is what the content is.
const THEATRE_BOARDS = new Set(['videos']);

const state = {
  me: null,
  ageOk: false,
  ageMode: 'self',
  boards: [],
  subscriptions: [],
  openReports: 0,
  unread: 0,
  messagesUnread: 0,
  feeds: [],
  moderates: [],
  prefs: {},
  railExtra: '',
  stats: null,
  ticker: [],
  trending: [],
  topics: [],
  sources: [],
  wire: null,
  view: localStorage.getItem('ad:view') || 'card',
  feedLoading: false,
  currentPost: null,
  scrollMemory: new Map(),
  // Timestamp of the newest post the reader has actually been shown, so the
  // "new posts" pill counts what arrived *after* they stopped looking.
  feedWatermark: 0,
  newCount: 0,
};

if (!VIEWS.includes(state.view)) state.view = 'card';

const view = qs('#view');

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/**
 * Reload identity and everything hanging off it. Called on boot, after sign-in,
 * and after anything that changes a counter — one round trip rather than five,
 * because these are all read from the same session row anyway.
 */
async function refreshMe() {
  try {
    const me = await api.get('/me');
    state.me = me.user;
    state.ageOk = me.ageOk;
    state.ageMode = me.ageMode;
    state.subscriptions = me.subscriptions || [];
    state.openReports = me.openReports || 0;
    state.unread = me.unread || 0;
    state.messagesUnread = me.messagesUnread || 0;
    state.feeds = me.feeds || [];
    state.moderates = me.moderates || [];
    state.prefs = me.prefs || {};
    // The server-side reveal preference wins over whatever this browser had.
    if (state.me && typeof me.prefs?.revealNsfw === 'boolean') setRevealAll(me.prefs.revealNsfw);
  } catch {
    /* keep defaults; the age gate and sign-in prompts still work */
  }
}

async function boot() {
  await refreshMe();

  watchSystemTheme();
  watchAdSlots();
  watchTopbar();
  watchAdBreakpoint();
  // One footer slot for the whole session rather than one per route change.
  mountPersistentAds();
  renderLegalCopy();
  renderTopbarNav();

  if (!state.ageOk) {
    showAgeGate();
    return;
  }

  await Promise.all([loadBoards(), loadStats(), loadTicker(), loadTrending(), loadTopics(), loadSources(), loadAds(), loadWireStatus()]);
  // After loadAds: the slot geometry has to exist before anything can mount.
  mountPersistentAds();
  renderRails();
  route();
}

function showAgeGate() {
  const gate = qs('#age-gate');
  gate.hidden = false;
  document.body.classList.add('is-gated');
  qs('#age-accept').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await api.post('/age/confirm', { confirm: true });
      state.ageOk = true;
      gate.hidden = true;
      document.body.classList.remove('is-gated');
      await Promise.all([loadBoards(), loadStats(), loadTicker(), loadTrending(), loadTopics(), loadSources(), loadAds(), loadWireStatus()]);
  // After loadAds: the slot geometry has to exist before anything can mount.
  mountPersistentAds();
      renderRails();
      route();
    } catch (err) {
      btn.disabled = false;
      toast(err.message, 'error');
    }
  });
}

function renderLegalCopy() {
  const line =
    state.ageMode === 'vendor'
      ? 'Access is gated by a third-party age-assurance provider.'
      : 'This deployment uses a self-declared age interstitial. That is not "highly effective age assurance" ' +
        'under the UK Online Safety Act, and does not satisfy the verification statutes now in force in more ' +
        'than half of US states. Configure an age-assurance provider before operating publicly.';
  qs('#age-gate-legal').textContent =
    'By entering you confirm you are of legal age in your jurisdiction and that adult material is lawful where you are.';
  qs('#footer-legal').textContent = line;
}

// ---------------------------------------------------------------------------
// Data loaders
// ---------------------------------------------------------------------------

async function loadBoards() {
  try {
    state.boards = (await api.get('/boards')).boards;
  } catch {
    state.boards = [];
  }
}

async function loadStats() {
  try {
    state.stats = await api.get('/stats');
  } catch {
    state.stats = null;
  }
}

async function loadTrending() {
  try {
    state.trending = (await api.get('/trending')).items;
  } catch {
    state.trending = [];
  }
}

async function loadAds() {
  try {
    setAdConfig((await api.get('/ads')).ads);
  } catch {
    setAdConfig({ enabled: false, slots: [] });
  }
}

async function loadTopics() {
  try {
    state.topics = (await api.get('/topics')).items;
  } catch {
    state.topics = [];
  }
}

async function loadWireStatus() {
  try {
    state.wire = await api.get('/wire/status');
  } catch {
    state.wire = null;
  }
}

async function loadSources() {
  try {
    state.sources = (await api.get('/sources')).sources;
  } catch {
    state.sources = [];
  }
}

async function loadTicker() {
  try {
    state.ticker = (await api.get('/news/ticker')).items;
    renderTicker();
  } catch {
    /* ticker is decorative */
  }
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

function renderTopbarNav() {
  const nav = qs('#topbar-nav');
  if (state.me) {
    const staff = state.me.role === 'mod' || state.me.role === 'admin';
    nav.innerHTML = `
      <a class="btn btn--sm btn--primary" href="/submit" data-link>
        ${icon('plus', { size: 16 })}<span class="btn-label">Post</span>
      </a>
      <a class="btn btn--sm btn--ghost iconbtn" href="/inbox" data-link title="Inbox">
        ${icon('bell', { size: 16 })}${state.unread ? `<span class="dot-badge">${state.unread > 99 ? '99+' : state.unread}</span>` : ''}
      </a>
      <a class="btn btn--sm btn--ghost iconbtn nav-desktop" href="/messages" data-link title="Messages">
        ${icon('messages', { size: 16 })}${state.messagesUnread ? `<span class="dot-badge">${state.messagesUnread}</span>` : ''}
      </a>
      <a class="btn btn--sm btn--ghost nav-desktop" href="/saved" data-link title="Saved">
        ${icon('bookmark', { size: 16 })}
      </a>
      ${staff
        ? `<a class="btn btn--sm nav-desktop" href="/mod" data-link>
             ${icon('shield', { size: 16 })}${state.openReports ? ` ${state.openReports}` : ''}
           </a>`
        : ''}
      <a class="btn btn--sm btn--ghost" href="/u/${attr(state.me.username)}" data-link>
        <span class="comment__avatar" style="${attr(avatarStyle(state.me.username))};width:20px;height:20px;font-size:9px">${esc(initials(state.me.username))}</span>
        <span class="btn-label">${esc(state.me.username)}</span>
      </a>
      <button class="btn btn--sm btn--ghost nav-desktop" data-logout title="Sign out">${icon('logOut', { size: 16 })}</button>`;
  } else {
    nav.innerHTML = `
      <button class="btn btn--sm btn--ghost nav-desktop" data-auth="login">Sign in</button>
      <button class="btn btn--sm btn--primary" data-auth="register">Join</button>`;
  }
}

function renderTicker() {
  const wrap = qs('#ticker');
  const track = qs('#ticker-track');
  if (!state.ticker.length) {
    wrap.hidden = true;
    return;
  }
  const items = state.ticker
    .map((i) => `<a class="ticker__item" href="/p/${i.id}" data-link><b>${esc(i.source || 'AfterDark')}</b>${esc(i.title)}</a>`)
    .join('');
  track.innerHTML = items + items; // duplicated so the marquee loop has no seam
  wrap.hidden = false;
}

function renderRails() {
  renderLeftRail();
  renderRightRail();
}

function renderLeftRail() {
  const path = location.pathname;
  const discussion = state.boards.filter((b) => b.kind !== 'news' && b.official);
  const founded = state.boards.filter((b) => !b.official);
  const news = state.boards.filter((b) => b.kind === 'news');

  const link = (b) => `
    <a class="board-link" href="/b/${attr(b.slug)}" data-link
       ${path === `/b/${b.slug}` ? 'aria-current="page"' : ''}>
      <span class="board-link__icon" style="--board-accent:${attr(b.accent)}">${boardIcon(b.slug, { size: 15 })}</span>
      ${esc(b.name)}
      <span class="board-link__count">${num(b.postCount)}</span>
    </a>`;

  const feedLink = (href, name, iconName, current) => `
    <a class="board-link" href="${href}" data-link ${current ? 'aria-current="page"' : ''}>
      <span class="board-link__icon">${icon(iconName, { size: 15 })}</span> ${esc(name)}
    </a>`;

  const accountPanel = state.me
    ? `<nav class="panel mobile-only">
         <p class="panel__title">${esc(state.me.username)}</p>
         <div class="board-list">
           ${feedLink(`/u/${attr(state.me.username)}`, 'Profile', 'user')}
           ${feedLink('/saved', 'Saved', 'bookmark')}
           ${isStaff() ? feedLink('/mod', `Mod queue${state.openReports ? ` · ${state.openReports}` : ''}`, 'shield') : ''}
           <button class="board-link" style="width:100%;text-align:left;background:none;border:0;font:inherit;cursor:pointer" data-logout>
             <span class="board-link__icon">${icon('logOut', { size: 15 })}</span> Sign out
           </button>
         </div>
       </nav>`
    : `<nav class="panel mobile-only">
         <p class="panel__title">Account</p>
         <button class="btn btn--sm btn--block" data-auth="login">Sign in</button>
       </nav>`;

  qs('#rail-left').innerHTML = `
    ${accountPanel}
    <nav class="panel">
      <p class="panel__title">${icon('layers', { size: 13 })} Feeds</p>
      <div class="board-list">
        ${feedLink('/', 'Home', 'home', path === '/')}
        ${feedLink('/news', 'Newsroom', 'newspaper', path === '/news')}
        ${state.me ? feedLink('/?scope=subscribed', 'My boards', 'star') : ''}
        ${state.me ? feedLink('/saved', 'Saved', 'bookmark', path === '/saved') : ''}
        ${feedLink('/popular', 'Popular', 'flame', path === '/popular')}
        ${feedLink('/all', 'All', 'layers', path === '/all')}
        ${feedLink('/sites', 'Directory', 'compass', path === '/sites')}
        ${feedLink('/communities', 'Communities', 'users', path === '/communities')}
        ${state.me ? feedLink('/settings', 'Settings', 'wrench', path === '/settings') : ''}
      </div>
    </nav>

    <nav class="panel">
      <p class="panel__title">${icon('newspaper', { size: 13 })} News &amp; policy</p>
      <div class="board-list">${news.map(link).join('')}</div>
    </nav>

    <nav class="panel">
      <p class="panel__title">${icon('messages', { size: 13 })} Site desks</p>
      <div class="board-list">${discussion.map(link).join('')}</div>
    </nav>

    ${state.me ? `
    <nav class="panel">
      <p class="panel__title">${icon('layers', { size: 13 })} Custom feeds</p>
      <div class="board-list">
        ${state.feeds.map((f) => `
          <a class="board-link" href="/f/${attr(f.slug)}" data-link ${path === `/f/${f.slug}` ? 'aria-current="page"' : ''}>
            <span class="board-link__icon">${icon('layers', { size: 14 })}</span>${esc(f.name)}
            <span class="board-link__count">${f.boards.length}</span>
          </a>`).join('')}
        <a class="board-link" href="/feeds" data-link>
          <span class="board-link__icon">${icon('plus', { size: 14 })}</span> New custom feed
        </a>
      </div>
    </nav>` : ''}

    ${founded.length ? `
    <nav class="panel">
      <p class="panel__title">${icon('users', { size: 13 })} Communities</p>
      <div class="board-list">${founded.map(link).join('')}</div>
    </nav>` : ''}

    <nav class="panel">
      <a class="btn btn--sm btn--block" href="/create" data-link>${icon('plus', { size: 14 })} Found a community</a>
    </nav>

    ${adSlot('railLeft')}

    ${adSlot('railLeftTall')}`;
}

/**
 * Which publishers the wire can actually reach.
 *
 * This is not diagnostics for its own sake. Whether a source works depends on
 * the network this is deployed behind — ISP and workplace filters intercept
 * adult domains and hand back a block page — and without saying so, a starved
 * wire is indistinguishable from a quiet news day.
 */
/**
 * The footer and sticky slots live outside the router, so they mount once
 * rather than reloading on every navigation — re-requesting an ad because
 * somebody clicked a link inflates impressions for nothing.
 *
 * They are re-mounted on a breakpoint change, though: the sticky bar is
 * phone-only and the footer swaps unit size, so a rotation or a resized window
 * would otherwise leave the wrong one (or neither) on screen.
 */
function mountPersistentAds() {
  qs('#footer-ad').innerHTML = adSlot('footer');
  qs('#sticky-ad').innerHTML = adSlot('sticky');
}

function watchAdBreakpoint() {
  const mq = window.matchMedia('(max-width: 760px)');
  mq.addEventListener('change', mountPersistentAds);
}

/**
 * When the wire last ran. The pull is silent when nothing new has been
 * published, which is most of the time — without this, a working wire and a
 * dead one look exactly the same from the outside.
 */
function wireLivePanel() {
  const w = state.wire;
  if (!w || !w.lastRunAt) return '';
  const stale = Date.now() - w.lastRunAt > 45 * 60000;
  return `<section class="panel wirelive${stale ? ' wirelive--stale' : ''}">
    <p class="panel__title">${icon('radio', { size: 13 })} Wire</p>
    <p class="wirelive__line">
      <span class="wirelive__dot"></span>
      Checked <b>${esc(timeAgo(w.lastRunAt))}</b>
    </p>
    <p class="wirelive__meta">
      ${w.healthy}/${w.sources} sources · ${num(w.itemsSeen)} items scanned
      ${w.newestStory ? `<br>Latest story ${esc(timeAgo(w.newestStory))}` : ''}
    </p>
    ${isStaff() ? `<button class="btn btn--sm btn--block" data-refresh-wire>Pull now</button>` : ''}
  </section>`;
}

function wireStatusPanel() {
  const enabled = state.sources.filter((s) => s.enabled);
  const down = enabled.filter((s) => s.lastStatus && s.lastStatus !== 'ok');
  if (!down.length) return '';
  const live = enabled.length - down.length;

  return `<section class="panel panel--warn">
    <p class="panel__title">${icon('radio', { size: 13 })} Wire status</p>
    <p class="panel__note">
      <b>${live}</b> of <b>${enabled.length}</b> sources reachable. These are being blocked
      before they get here — usually a network-level content filter, not a broken feed:
    </p>
    <ul class="sourcelist">
      ${down.slice(0, 8).map((s) => `
        <li><span class="dot dot--down"></span>${esc(s.name)}<span class="sourcelist__kind">${esc(s.kind)}</span></li>
      `).join('')}
    </ul>
  </section>`;
}

function renderRightRail() {
  const s = state.stats;
  const wire = state.ticker.slice(0, 5);
  const wireById = new Map();
  for (const item of state.ticker) wireById.set(item.id, item);

  qs('#rail-right').innerHTML = `
    ${state.railExtra || ''}

    ${s ? `
    <section class="panel">
      <p class="panel__title">${icon('users', { size: 13 })} Community</p>
      <div class="stat-grid">
        <div class="stat stat--live">
          <div class="stat__value">${num(s.online)}</div>
          <div class="stat__label">online now</div>
        </div>
        <div class="stat">
          <div class="stat__value">${num(s.users)}</div>
          <div class="stat__label">members</div>
        </div>
        <div class="stat">
          <div class="stat__value">${num(s.postsToday)}</div>
          <div class="stat__label">posts today</div>
        </div>
        <div class="stat">
          <div class="stat__value">${num(s.commentsToday)}</div>
          <div class="stat__label">comments today</div>
        </div>
      </div>
    </section>` : ''}

    ${adSlot('rail')}

    ${state.topics.length ? `
    <section class="panel">
      <p class="panel__title">${icon('hash', { size: 13 })} In the news</p>
      <ol class="topiclist">
        ${state.topics.slice(0, 10).map((t, i) => `
          <li>
            <a href="/t/${attr(t.slug)}" data-link>
              <span class="topiclist__rank">${i + 1}</span>
              <span class="topiclist__label">${esc(t.label)}</span>
              <span class="topiclist__n">${t.recent}</span>
            </a>
          </li>`).join('')}
      </ol>
    </section>` : ''}

    ${wireLivePanel()}

    ${adSlot('railMid')}

    ${state.trending.length ? `
    <section class="panel">
      <p class="panel__title">${icon('flame', { size: 13 })} Talked about today</p>
      ${state.trending.map((t, i) => `
        <a class="trend" href="/p/${t.id}" data-link>
          <span class="trend__rank">${i + 1}</span>
          <span>
            <span class="trend__title">${esc(t.title)}</span>
            <span class="trend__meta">${esc(t.board_name)} · <b>${num(t.recent_comments || t.comment_count)}</b> comments</span>
          </span>
        </a>`).join('')}
    </section>` : ''}

    ${wireStatusPanel()}

    ${wire.length ? `
    <section class="panel">
      <p class="panel__title">${icon('trendingUp', { size: 13 })} The Wire</p>
      ${wire.map((i) => `
        <a class="wire-item" href="/p/${i.id}" data-link>
          ${i.img ? `<span class="wire-item__thumb">${media({ ...i, board: { slug: i.board } }, 'thumb')}</span>` : ''}
          <span>
            <span class="wire-item__src">${esc(i.source || 'AfterDark')} · ${esc(timeAgo(i.publishedAt))}</span>
            ${esc(i.title)}
          </span>
        </a>`).join('')}
      <a class="btn btn--sm btn--block btn--ghost" href="/news" data-link style="margin-top:12px">Open the newsroom</a>
    </section>` : ''}

    <section class="panel panel--accent">
      <p class="panel__title">${icon('shieldCheck', { size: 13 })} House rules</p>
      <ol class="rule-list">
        <li>Nothing involving minors. Ever. Instant permanent ban.</li>
        <li>No non-consensual material, including synthetic media of real people.</li>
        <li>No personal information about anyone, performers included.</li>
        <li>Nothing is hosted here. Links go to the publisher; no trading, no requests.</li>
        <li>Argue with the argument, not the person.</li>
      </ol>
      <a class="btn btn--sm btn--block btn--ghost" href="/b/meta" data-link style="margin-top:12px">Full rules</a>
    </section>

    ${adSlot('railTall')}`;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const ROUTES = [
  [/^\/$/, viewFeed],
  [/^\/news\/?$/, viewNews],
  [/^\/saved\/?$/, viewSaved],
  [/^\/b\/([\w-]+)\/?$/, viewBoard],
  [/^\/p\/(\d+)\/?$/, viewPost],
  [/^\/u\/([\w-]+)\/?$/, viewProfile],
  [/^\/t\/([\w-]+)\/?$/, viewTopic],
  [/^\/communities\/?$/, viewCommunities],
  [/^\/sites\/?$/, viewSites],
  [/^\/inbox\/?$/, viewInbox],
  [/^\/messages\/?$/, () => viewMessages(null)],
  [/^\/messages\/(\d+)\/?$/, viewMessages],
  [/^\/settings\/?$/, viewSettings],
  [/^\/feeds\/?$/, viewFeedManager],
  [/^\/f\/([\w-]+)\/?$/, viewCustomFeed],
  [/^\/popular\/?$/, () => viewFeed('popular')],
  [/^\/all\/?$/, () => viewFeed('all')],
  [/^\/create\/?$/, viewCreateCommunity],
  [/^\/b\/([\w-]+)\/settings\/?$/, viewCommunitySettings],
  [/^\/search\/?$/, viewSearch],
  [/^\/submit\/?$/, viewSubmit],
  [/^\/mod\/?$/, viewMod],
];

function navigate(href, { replace = false } = {}) {
  const url = new URL(href, location.origin);
  if (url.origin !== location.origin) {
    location.href = href;
    return;
  }
  // Remember where we were, so Back lands where the reader left off.
  state.scrollMemory.set(location.pathname + location.search, window.scrollY);
  if (replace) history.replaceState({}, '', url);
  else history.pushState({}, '', url);
  document.body.classList.remove('nav-open');
  route();
}

async function route() {
  // Anything a previous page pinned into the rail belongs to that page.
  state.railExtra = '';
  if (!state.ageOk) return;
  const path = location.pathname;
  const key = path + location.search;
  view.innerHTML = skeleton(3);
  renderLeftRail();

  for (const [pattern, handler] of ROUTES) {
    const match = path.match(pattern);
    if (match) {
      try {
        await handler(...match.slice(1));
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          view.innerHTML = emptyState('Not found', err.message);
        } else if (err instanceof ApiError && err.ageRequired) {
          showAgeGate();
        } else {
          view.innerHTML = errorState(err.message || 'Unknown error');
        }
      }
      observeReveals(view);
      watchReadingProgress();
      const remembered = state.scrollMemory.get(key);
      window.scrollTo({ top: remembered ?? 0, behavior: 'auto' });
      return;
    }
  }
  view.innerHTML = emptyState('Nothing here', `No page matches ${path}.`,
    '<a class="btn btn--primary" href="/" data-link>Back to the front page</a>');
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const SORT_LABELS = { hot: 'Hot', new: 'New', top: 'Top', rising: 'Rising' };
const SORT_ICONS = { hot: 'flame', new: 'clock', top: 'trendingUp', rising: 'sparkle' };

function viewSwitch() {
  const labels = { card: 'Card view', compact: 'Compact view', classic: 'Classic view' };
  const icons = { card: 'viewCard', compact: 'viewCompact', classic: 'viewClassic' };
  return `<span class="viewswitch">
    ${VIEWS.map((v) => `
      <button data-view="${v}" aria-pressed="${state.view === v}" title="${labels[v]}" aria-label="${labels[v]}">
        ${icon(icons[v], { size: 16 })}
      </button>`).join('')}
  </span>`;
}

function sortTabs(active, { boardSlug = '', scope = '', showWindow = true, theatre = false } = {}) {
  const base = boardSlug ? `/b/${boardSlug}` : '/';
  const scopeParam = scope ? `&scope=${scope}` : '';
  // On a clip shelf "most watched" is the sort that means anything, so it leads.
  const labels = theatre ? { views: 'Most watched', ...SORT_LABELS } : SORT_LABELS;
  const tabs = Object.entries(labels)
    .map(([key, label]) => `
      <a class="tab" role="tab" aria-selected="${key === active}" href="${base}?sort=${key}${scopeParam}" data-link>
        ${icon(SORT_ICONS[key] || 'eye', { size: 15 })} ${label}
      </a>`)
    .join('');

  const windowSelect =
    showWindow && (active === 'top' || active === 'rising')
      ? `<select class="select" data-window>
          ${['day', 'week', 'month', 'year', 'all']
            .map((w) => `<option value="${w}" ${currentWindow() === w ? 'selected' : ''}>Past ${w === 'all' ? 'all time' : w}</option>`)
            .join('')}
        </select>`
      : '';

  return `<div class="tabs tabs--sticky" role="tablist">${tabs}<span class="tabs__spacer"></span>${windowSelect}${theatre ? '' : viewSwitch()}</div>`;
}

const params = () => new URLSearchParams(location.search);
const currentSort = () => (SORT_LABELS[params().get('sort')] ? params().get('sort') : 'hot');
const currentWindow = () => params().get('t') || 'week';
const feedOpts = (extra = {}) => ({ view: state.view, ...extra });

async function viewFeed(mode = 'home') {
  // Home is your communities; Popular is the whole site by heat; All is the
  // whole site by recency. Signed out, Home has nothing to be, so it is Popular.
  const sort = mode === 'all' ? 'new' : currentSort();
  const scope = mode === 'home' && state.me && state.subscriptions.length ? 'subscribed' : '';
  const data = await api.get(`/feed${query({ sort, t: currentWindow(), scope, limit: 25 })}`);

  const HEADERS = {
    popular: ['flame', 'Popular', 'The whole site, ranked by what is moving right now.'],
    all: ['layers', 'All', 'Everything as it lands, newest first, unfiltered.'],
  };
  const head = HEADERS[mode];
  const header = head
    ? `<div class="news-hero news-hero--slim">
         <span class="news-hero__kicker">${icon(head[0], { size: 13 })} ${esc(head[1])}</span>
         <h1>${esc(head[1])}</h1>
         <p>${esc(head[2])}</p>
       </div>`
    : scope === 'subscribed'
      ? `<div class="news-hero news-hero--slim">
           <span class="news-hero__kicker">${icon('star', { size: 13 })} Home</span>
           <h1>Your communities</h1>
           <p>Everything from what you follow. <a href="/popular" data-link>Popular</a> is the whole site.</p>
         </div>`
      : '';

  const body = data.items.length
    ? feedList(data.items, feedOpts())
    : emptyState(
        data.empty === 'no-subscriptions' ? 'You have not subscribed to anything' : 'Nothing here yet',
        data.empty === 'no-subscriptions'
          ? 'Follow a few boards and this feed fills up.'
          : 'Be the first to start a thread.',
        '<a class="btn btn--primary" href="/submit" data-link>Start a thread</a>'
      );

  view.innerHTML = `${adSlot('top')}${header}${composerBar()}${newPostsPill()}${sortTabs(sort, { scope })}${body}${moreZone(data.nextCursor)}`;
  markWatermark(data.items);
  observeSentinel();
}

// ---------------------------------------------------------------------------
// "N new posts"
//
// A feed that silently goes stale is a feed people stop returning to. Polling a
// count is far cheaper than re-running the query, so the reader is told there is
// something new and decides for themselves — rather than having the page pulled
// out from under them mid-scroll.
// ---------------------------------------------------------------------------

let updateTimer = null;

function markWatermark(items) {
  const newest = items.reduce((max, p) => Math.max(max, p.createdAt || 0), 0);
  if (newest) state.feedWatermark = newest;
  state.newCount = 0;
  scheduleUpdateCheck();
}

/**
 * Reddit's fake-input composer. A text box you can picture yourself typing in
 * converts far better than a button labelled "submit", so the feed opens with
 * one whether or not the reader is signed in — the sign-in prompt is a cheaper
 * interruption than never being asked to post at all.
 */
function composerBar(boardSlug = '') {
  const href = boardSlug ? `/submit?board=${encodeURIComponent(boardSlug)}` : '/submit';
  const me = state.me;
  return `<div class="composer-bar">
    <span class="composer-bar__avatar" aria-hidden="true">${me ? esc(initials(me.username)) : icon('user', { size: 17 })}</span>
    <a class="composer-bar__field" href="${attr(href)}" data-link>${me ? 'Start a thread…' : 'Sign in to start a thread'}</a>
    <a class="composer-bar__btn" href="${attr(href)}" data-link aria-label="New post">${icon('image', { size: 17 })}</a>
  </div>`;
}

function newPostsPill() {
  return `<div class="newpill-slot" data-newpill hidden></div>`;
}

function scheduleUpdateCheck() {
  clearInterval(updateTimer);
  if (!state.feedWatermark) return;
  updateTimer = setInterval(checkForUpdates, 45000);
}

async function checkForUpdates() {
  // Piggyback on the poll the "new posts" pill already makes.
  loadWireStatus().then(() => renderRightRail()).catch(() => {});
  const slot = document.querySelector('[data-newpill]');
  if (!slot || document.hidden || !state.feedWatermark) return;
  const boardSlug = location.pathname.match(/^\/b\/([\w-]+)/)?.[1] || '';
  try {
    const { count } = await api.get(`/feed/updates${query({ since: state.feedWatermark, board: boardSlug })}`);
    state.newCount = count;
    if (!count) {
      slot.hidden = true;
      return;
    }
    slot.hidden = false;
    slot.innerHTML = `<button class="newpill" data-load-new>
      ${icon('arrowUp', { size: 15 })} ${count} new ${count === 1 ? 'post' : 'posts'}
    </button>`;
  } catch {
    /* a failed poll is not worth telling the reader about */
  }
}

/**
 * The rules panel.
 *
 * Rules carry a public citation count, which is the whole point of the system:
 * a rule enforced four hundred times and one enforced never are visibly
 * different objects, and a community can see its own moderation drifting
 * without anyone having to take a moderator's word for it.
 */
function rulesPanel(board) {
  const rules = board.rules || [];
  if (!rules.length) return '';
  const total = rules.reduce((n, r) => n + (r.cited_count || 0), 0);

  return `<details class="rules" ${board.canModerate ? 'open' : ''}>
    <summary class="rules__summary">
      <span class="panel__title" style="margin:0">${icon('scale', { size: 13 })} Rules</span>
      <span class="rules__count">${rules.length} · ${total} enforcement${total === 1 ? '' : 's'}</span>
    </summary>
    <ol class="rules__list">
      ${rules.map((r) => `
        <li class="rule">
          <span class="rule__n">${r.position}</span>
          <span class="rule__body">
            <span class="rule__title">${esc(r.title)}</span>
            ${r.detail ? `<span class="rule__detail">${esc(r.detail)}</span>` : ''}
          </span>
          <span class="rule__cited${r.cited_count ? ' rule__cited--live' : ''}"
                title="Times a removal in this community cited this rule">${num(r.cited_count || 0)}</span>
        </li>`).join('')}
    </ol>
    ${board.moderators?.length
      ? `<p class="rules__mods">Moderated by ${board.moderators.map((m) =>
          `<a href="/u/${attr(m.username)}" data-link>${esc(m.username)}</a>${m.role === 'owner' ? ' <span class="badge badge--mod">owner</span>' : ''}`).join(', ')}</p>`
      : ''}
    ${board.canConfigure ? `<a class="btn btn--sm" href="/b/${attr(board.slug)}/settings" data-link>${icon('wrench', { size: 14 })} Manage</a>` : ''}
  </details>`;
}

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

const NOTIF_ICON = {
  reply: 'comment', comment_reply: 'comment', mention: 'user',
  mod: 'shield', award: 'star', message: 'messages', system: 'bell',
};

async function viewInbox() {
  if (!state.me) {
    view.innerHTML = emptyState('Sign in first', 'Your inbox lives with your account.',
      '<button class="btn btn--primary" data-auth="login">Sign in</button>');
    return;
  }
  const filter = params().get('filter') || 'all';
  const data = await api.get(`/inbox${query({ filter })}`);

  const tab = (key, label, n) => `<a class="tab" role="tab" aria-selected="${key === filter}"
    href="/inbox?filter=${key}" data-link>${esc(label)}${n ? ` <span class="tab__n">${n}</span>` : ''}</a>`;

  view.innerHTML = `
    <div class="news-hero news-hero--slim">
      <span class="news-hero__kicker">${icon('bell', { size: 13 })} Inbox</span>
      <h1>What happened</h1>
      <p>Replies to you, mentions, awards, and any moderator action on your own posts —
         with the rule it cited.</p>
    </div>

    <div class="tabs tabs--sticky" role="tablist">
      ${tab('all', 'All')}${tab('unread', 'Unread', data.unread)}${tab('replies', 'Replies')}${tab('mentions', 'Mentions')}
      <span class="tabs__spacer"></span>
      <a class="tab" href="/messages" data-link>${icon('messages', { size: 15 })} Messages${data.messagesUnread ? ` <span class="tab__n">${data.messagesUnread}</span>` : ''}</a>
      ${data.unread ? '<button class="btn btn--sm" data-read-all>Mark all read</button>' : ''}
    </div>

    ${data.notifications.length ? `
      <ul class="notifs">
        ${data.notifications.map((n) => `
          <li class="notif${n.read_at ? '' : ' notif--unread'}">
            <a href="${n.post_id ? `/p/${n.post_id}` : '/inbox'}" data-link>
              <span class="notif__icon">${icon(NOTIF_ICON[n.kind] || 'bell', { size: 15 })}</span>
              <span class="notif__body">
                <span class="notif__title">${esc(n.title)}</span>
                ${n.body ? `<span class="notif__text">${esc(n.body)}</span>` : ''}
                <span class="notif__meta">${esc(timeAgo(n.created_at))}${n.actor ? ` · ${esc(n.actor)}` : ''}</span>
              </span>
            </a>
          </li>`).join('')}
      </ul>`
      : emptyState('Nothing yet', filter === 'unread' ? 'You are caught up.' : 'Replies and mentions land here.')}`;

  // Opening the inbox is reading it — but only what is on screen.
  if (data.notifications.some((n) => !n.read_at)) {
    setTimeout(() => {
      api.post('/inbox/read', { ids: data.notifications.filter((n) => !n.read_at).map((n) => n.id) })
        .then(({ unread }) => { state.unread = unread; renderTopbarNav(); })
        .catch(() => {});
    }, 1200);
  }
}

async function viewMessages(conversationId) {
  if (!state.me) {
    view.innerHTML = emptyState('Sign in first', 'Messages live with your account.',
      '<button class="btn btn--primary" data-auth="login">Sign in</button>');
    return;
  }

  const { conversations } = await api.get('/messages');
  const active = conversationId ? await api.get(`/messages/${conversationId}`).catch(() => null) : null;

  view.innerHTML = `
    <div class="news-hero news-hero--slim">
      <span class="news-hero__kicker">${icon('messages', { size: 13 })} Messages</span>
      <h1>Direct</h1>
      <p>Private, between two accounts. Blocking someone stops them writing to you.</p>
    </div>

    <div class="dm">
      <aside class="dm__list">
        ${conversations.length ? conversations.map((c) => `
          <a class="dmrow${active?.id === c.id ? ' dmrow--on' : ''}${c.unread ? ' dmrow--unread' : ''}"
             href="/messages/${c.id}" data-link>
            <span class="dmrow__avatar" style="${attr(avatarStyle(c.other))}">${esc(initials(c.other))}</span>
            <span class="dmrow__body">
              <span class="dmrow__top">
                <span class="dmrow__name">${esc(c.other)}</span>
                <time>${esc(timeAgo(c.last_at))}</time>
              </span>
              <span class="dmrow__preview">${c.last_sender === state.me.id ? 'You: ' : ''}${esc(c.preview || '')}</span>
            </span>
            ${c.unread ? `<span class="dmrow__n">${c.unread}</span>` : ''}
          </a>`).join('')
          : '<p class="dm__empty">No conversations yet.</p>'}
        <form class="dm__new" id="dm-new">
          <input class="input input--sm" name="to" placeholder="username" maxlength="20" required />
          <button class="btn btn--sm btn--primary" type="submit">${icon('plus', { size: 14 })}</button>
        </form>
      </aside>

      <section class="dm__thread">
        ${active ? `
          <header class="dm__head">
            <a href="/u/${attr(active.other)}" data-link>${esc(active.other)}</a>
            <button class="btn btn--sm" data-block="${attr(active.other)}">Block</button>
          </header>
          <div class="dm__scroll" id="dm-scroll">
            ${active.messages.map((m) => `
              <div class="bubble${m.mine ? ' bubble--mine' : ''}">
                <span class="bubble__body">${markdown(m.body)}</span>
                <time class="bubble__time">${esc(timeAgo(m.created_at))}</time>
              </div>`).join('')}
          </div>
          <form class="dm__compose" id="dm-send" data-to="${attr(active.other)}">
            <textarea class="textarea" name="body" rows="2" placeholder="Write a message…" required></textarea>
            <button class="btn btn--primary" type="submit">Send</button>
          </form>`
          : '<p class="dm__empty">Pick a conversation, or start one.</p>'}
      </section>
    </div>`;

  const scroll = qs('#dm-scroll');
  if (scroll) scroll.scrollTop = scroll.scrollHeight;

  qs('#dm-new')?.addEventListener('submit', (e) => {
    e.preventDefault();
    startConversation(e.currentTarget.to.value.trim());
  });

  qs('#dm-send')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const body = form.body.value.trim();
    if (!body) return;
    form.body.value = '';
    try {
      await api.post('/messages', { to: form.dataset.to, body });
      route();
    } catch (err) {
      toast(err.message, 'error');
      form.body.value = body;
    }
  });
}

async function startConversation(username) {
  if (!username) return;
  const body = prompt(`Message to ${username}:`);
  if (!body || !body.trim()) return;
  try {
    const { conversationId } = await api.post('/messages', { to: username, body: body.trim() });
    navigate(`/messages/${conversationId}`);
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function viewSettings() {
  if (!state.me) {
    view.innerHTML = emptyState('Sign in first', 'Settings belong to an account.',
      '<button class="btn btn--primary" data-auth="login">Sign in</button>');
    return;
  }
  const data = await api.get('/settings');
  const p = data.prefs;

  const toggle = (key, label, hint) => `
    <label class="pref">
      <input type="checkbox" name="${key}" ${p[key] ? 'checked' : ''} />
      <span class="pref__body"><span class="pref__label">${esc(label)}</span>
      <span class="pref__hint">${esc(hint)}</span></span>
    </label>`;

  view.innerHTML = `
    <div class="news-hero news-hero--slim">
      <span class="news-hero__kicker">${icon('wrench', { size: 13 })} Settings</span>
      <h1>${esc(state.me.username)}</h1>
      <p>${num(data.profile.postKarma)} post karma · ${num(data.profile.commentKarma)} comment karma ·
         ${data.awardsReceived} award${data.awardsReceived === 1 ? '' : 's'} received</p>
    </div>

    <form class="panel form" id="set-profile">
      <p class="panel__title">Profile</p>
      <div class="field">
        <label class="field__label" for="set-bio">Bio</label>
        <textarea class="textarea" id="set-bio" name="bio" rows="3" maxlength="300">${esc(data.profile.bio || '')}</textarea>
      </div>
      <p class="panel__title" style="margin-top:16px">Reading</p>
      ${toggle('revealNsfw', 'Show explicit thumbnails unblurred', 'Applies everywhere, on every device you sign in from.')}
      ${toggle('hideNsfwBoards', 'Hide explicit communities from feeds', 'They stay reachable by direct link.')}
      ${toggle('autoplay', 'Autoplay video where the publisher allows it', 'Off by default — autoplay on an adult site is a good way to get someone fired.')}
      <div class="form-actions"><button class="btn btn--primary" type="submit">Save</button></div>
    </form>

    <section class="panel">
      <p class="panel__title">Awards</p>
      <p class="panel__note">
        <b>${data.awardsRemaining}</b> of 5 left this month. Awards are not bought —
        everyone gets the same handful, so giving one costs attention rather than money.
      </p>
    </section>

    <form class="panel form" id="set-password">
      <p class="panel__title">Password</p>
      <div class="field">
        <label class="field__label" for="pw-current">Current</label>
        <input class="input" id="pw-current" name="current" type="password" required autocomplete="current-password" />
      </div>
      <div class="field">
        <label class="field__label" for="pw-next">New</label>
        <input class="input" id="pw-next" name="next" type="password" minlength="10" required autocomplete="new-password" />
        <p class="field__hint">At least 10 characters. Every other signed-in session will be ended.</p>
      </div>
      <div class="form-actions"><button class="btn btn--primary" type="submit">Change password</button></div>
    </form>

    <section class="panel">
      <p class="panel__title">Blocked accounts</p>
      ${data.blocked.length ? `<ul class="modlist">
        ${data.blocked.map((b) => `<li><a href="/u/${attr(b.username)}" data-link>${esc(b.username)}</a>
          <button class="btn btn--sm" data-unblock="${attr(b.username)}">Unblock</button></li>`).join('')}
      </ul>` : '<p class="panel__note">Nobody. Blocking hides their posts from you and stops them messaging you — it does not hide you from them.</p>'}
    </section>`;

  qs('#set-profile').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    try {
      const { prefs } = await api.patch('/settings', {
        bio: f.bio.value,
        prefs: {
          revealNsfw: f.revealNsfw.checked,
          hideNsfwBoards: f.hideNsfwBoards.checked,
          autoplay: f.autoplay.checked,
        },
      });
      // The reveal preference is also read client-side, so keep them in step.
      setRevealAll(prefs.revealNsfw);
      state.prefs = prefs;
      toast('Saved.', 'ok');
    } catch (err) { toast(err.message, 'error'); }
  });

  qs('#set-password').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    try {
      await api.post('/settings/password', { current: f.current.value, next: f.next.value });
      f.reset();
      toast('Password changed. Other sessions signed out.', 'ok');
    } catch (err) { toast(err.message, 'error'); }
  });
}

// ---------------------------------------------------------------------------
// Custom feeds
// ---------------------------------------------------------------------------

async function viewCustomFeed(slug) {
  if (!state.me) {
    view.innerHTML = emptyState('Sign in first', 'Custom feeds belong to an account.',
      '<button class="btn btn--primary" data-auth="login">Sign in</button>');
    return;
  }
  const data = await api.get(`/feeds/${encodeURIComponent(slug)}/posts${query({ sort: currentSort() })}`);
  const feed = data.feed;

  view.innerHTML = `
    <div class="news-hero news-hero--slim">
      <span class="news-hero__kicker">${icon('layers', { size: 13 })} Custom feed</span>
      <h1>${esc(feed.name)}</h1>
      <p>${feed.boards.length
        ? feed.boards.map((b) => `<a href="/b/${attr(b.slug)}" data-link>${esc(b.name)}</a>`).join(' · ')
        : 'No communities in this feed yet.'}</p>
      <a class="btn btn--sm" href="/feeds" data-link>${icon('wrench', { size: 14 })} Edit</a>
    </div>
    ${adSlot('top')}
    ${sortTabs(currentSort())}
    ${data.items.length ? feedList(data.items, feedOpts())
      : emptyState('Quiet', 'Nothing from these communities yet.')}
    ${moreZone(data.nextCursor, `cfeed:${slug}`)}`;
  markWatermark(data.items);
  observeSentinel();
}

async function viewFeedManager() {
  if (!state.me) {
    view.innerHTML = emptyState('Sign in first', 'Custom feeds belong to an account.',
      '<button class="btn btn--primary" data-auth="login">Sign in</button>');
    return;
  }
  const { feeds } = await api.get('/feeds');

  view.innerHTML = `
    <div class="news-hero news-hero--slim">
      <span class="news-hero__kicker">${icon('layers', { size: 13 })} Custom feeds</span>
      <h1>Your own front pages</h1>
      <p>A named set of communities read as one feed. Useful when "everything I follow" is
         two different interests fighting for the same screen.</p>
    </div>

    <form class="panel form" id="cf-new">
      <div class="field">
        <label class="field__label" for="cf-name">Name</label>
        <input class="input" id="cf-name" name="name" maxlength="40" required placeholder="Policy watch" />
      </div>
      <div class="field">
        <label class="field__label">Communities</label>
        <div class="pickgrid">
          ${state.boards.map((b) => `
            <label class="pick"><input type="checkbox" name="boards" value="${attr(b.slug)}" />
            <span>${esc(b.name)}</span></label>`).join('')}
        </div>
      </div>
      <div class="form-actions"><button class="btn btn--primary" type="submit">Create feed</button></div>
    </form>

    ${feeds.map((f) => `
      <section class="panel">
        <p class="panel__title">${esc(f.name)}</p>
        <p class="panel__note">${f.boards.length
          ? f.boards.map((b) => esc(b.name)).join(' · ')
          : 'No communities yet.'}</p>
        <div class="form-actions">
          <a class="btn btn--sm" href="/f/${attr(f.slug)}" data-link>Open</a>
          <button class="btn btn--sm" data-drop-feed="${attr(f.slug)}">Delete</button>
        </div>
      </section>`).join('')}`;

  qs('#cf-new').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const boards = [...f.querySelectorAll('[name=boards]:checked')].map((i) => i.value);
    try {
      await api.post('/feeds', { name: f.name.value, boards });
      await refreshMe();
      renderRails();
      route();
    } catch (err) { toast(err.message, 'error'); }
  });
}

// ---------------------------------------------------------------------------
// Communities
// ---------------------------------------------------------------------------

/**
 * The directory.
 *
 * Grouped by what a platform actually *is* — a tube aggregator, a studio
 * subscription, a cam platform and a creator marketplace are four different
 * businesses with four different relationships to the people on them, and
 * flattening them into one list of links loses the only useful information.
 */
async function viewSites() {
  const { categories } = await api.get('/sites');

  view.innerHTML = `
    <div class="news-hero">
      <span class="news-hero__kicker">${icon('compass', { size: 13 })} Directory</span>
      <h1>Where it all actually lives</h1>
      <p>Mainstream platforms, grouped by what they are rather than lumped together.
         Leak sites and "free premium" mirrors are deliberately absent — they are what
         the newsroom spends its week reporting lawsuits about.</p>
    </div>

    ${categories.map((cat, i) => `
      <section class="dircat">
        <div class="dircat__head">
          <h2>${esc(cat.label)}</h2>
          <p>${esc(cat.blurb)}</p>
        </div>
        <div class="dirgrid">
          ${cat.sites.map((site) => `
            <a class="dirsite" href="${attr(site.url)}" target="_blank"
               rel="noopener noreferrer nofollow ugc" data-site="${site.id}">
              <span class="dirsite__top">
                <span class="dirsite__name">${esc(site.name)}</span>
                ${site.nsfw ? '<span class="dirsite__flag">18+</span>' : ''}
              </span>
              <span class="dirsite__blurb">${esc(site.blurb)}</span>
              <span class="dirsite__go">${esc(hostOf(site.url))}${icon('externalLink', { size: 12 })}</span>
            </a>`).join('')}
        </div>
      </section>${i % 2 === 1 ? adSlot('section') : ''}`).join('')}`;
}

async function viewCommunities() {
  const sort = params().get('sort') || 'active';
  const { communities } = await api.get(`/communities${query({ sort })}`);

  const tab = (key, label) => `<a class="tab" role="tab" aria-selected="${key === sort}"
    href="/communities?sort=${key}" data-link>${label}</a>`;

  view.innerHTML = `
    <div class="news-hero">
      <span class="news-hero__kicker">${icon('layers', { size: 13 })} Communities</span>
      <h1>Every corner of this place</h1>
      <p>Site desks are run by staff. Everything else was founded by someone who wanted it to exist —
         with its own rules, its own moderators, and a public record of how those rules get used.</p>
      <a class="btn btn--primary" href="/create" data-link>${icon('plus', { size: 15 })} Found a community</a>
    </div>

    <div class="tabs tabs--sticky" role="tablist">
      ${tab('active', 'Active')}${tab('members', 'Largest')}${tab('new', 'Newest')}
    </div>

    ${adSlot('section')}

    <div class="commgrid">
      ${communities.map((c) => `
        <article class="comm" style="--board-accent:${attr(c.accent)}">
          <a class="comm__head" href="/b/${attr(c.slug)}" data-link>
            <span class="comm__icon">${boardIcon(c.slug, { size: 18 })}</span>
            <span class="comm__names">
              <span class="comm__name">${esc(c.name)}</span>
              <span class="comm__slug">/b/${esc(c.slug)}</span>
            </span>
            ${c.official ? '<span class="badge badge--mod">site</span>' : ''}
            ${c.nsfw ? '<span class="badge badge--removed">18+</span>' : ''}
          </a>
          ${c.tagline ? `<p class="comm__tagline">${esc(c.tagline)}</p>` : ''}
          <div class="comm__stats">
            <span><b>${num(c.memberCount)}</b> members</span>
            <span><b>${num(c.postCount)}</b> posts</span>
            ${c.recentPosts ? `<span class="comm__live"><b>${num(c.recentPosts)}</b> this week</span>` : ''}
          </div>
          <div class="comm__foot">
            ${c.owner ? `<span class="comm__owner">founded by ${esc(c.owner)}</span>` : '<span class="comm__owner">site desk</span>'}
            ${state.me ? `<button class="btn btn--sm ${c.subscribed ? '' : 'btn--primary'}" data-subscribe="${attr(c.slug)}">
              ${c.subscribed ? 'Joined' : 'Join'}</button>` : ''}
          </div>
        </article>`).join('')}
    </div>

    ${adSlot('gridMid')}`;
}

const DEFAULT_RULES = [
  { title: 'Stay on topic', detail: 'Posts should be about what this community is for.' },
  { title: 'No personal information', detail: 'About anyone — members, performers, or third parties.' },
  { title: 'Nothing involving minors', detail: 'Absolute. Reported, not just removed.' },
];

async function viewCreateCommunity() {
  if (!state.me) {
    view.innerHTML = emptyState('Sign in first', 'Communities belong to the account that founds them.',
      '<button class="btn btn--primary" data-auth="login">Sign in</button>');
    return;
  }

  view.innerHTML = `
    <div class="news-hero">
      <span class="news-hero__kicker">${icon('plus', { size: 13 })} New community</span>
      <h1>Found a community</h1>
      <p>You will own it, moderate it, and appoint anyone else who does.</p>
    </div>

    <form class="panel form" id="create-community">
      <div class="field">
        <label class="field__label" for="cc-slug">Address</label>
        <div class="slugfield"><span>/b/</span><input class="input" id="cc-slug" name="slug" required
          maxlength="24" placeholder="cam-tech" autocomplete="off"
          pattern="[a-z0-9][a-z0-9_\\-]{1,22}[a-z0-9]"
          title="3–24 characters: lowercase letters, numbers, hyphen or underscore" /></div>
        <p class="field__hint">Permanent. Lowercase letters, numbers, hyphen or underscore.</p>
      </div>

      <div class="field">
        <label class="field__label" for="cc-name">Display name</label>
        <input class="input" id="cc-name" name="name" required maxlength="60" placeholder="Cam Tech" />
      </div>

      <div class="field">
        <label class="field__label" for="cc-tagline">One-line description</label>
        <input class="input" id="cc-tagline" name="tagline" maxlength="140"
               placeholder="Streaming stacks, hardware, and the software nobody admits to using" />
      </div>

      <div class="field">
        <label class="field__label" for="cc-description">What is this place for?</label>
        <textarea class="textarea" id="cc-description" name="description" maxlength="2000" rows="4"
                  placeholder="The longer version, shown on the community page."></textarea>
      </div>

      <div class="field">
        <label class="field__label">Rules</label>
        <p class="field__hint" style="margin-bottom:8px">
          Every removal in your community has to cite one of these by number, and the count is public.
          Write rules you are willing to be measured against.
        </p>
        <div id="cc-rules"></div>
        <button class="btn btn--sm" type="button" id="cc-add-rule">${icon('plus', { size: 14 })} Add rule</button>
      </div>

      <div class="field field--row">
        <label class="check"><input type="checkbox" name="nsfw" /> <span>Explicit imagery — blur thumbnails by default</span></label>
      </div>

      <div class="form-actions">
        <button class="btn btn--primary" type="submit">Found it</button>
        <a class="btn btn--ghost" href="/communities" data-link>Cancel</a>
      </div>
    </form>`;

  const slot = qs('#cc-rules');
  const addRule = (rule = { title: '', detail: '' }) => {
    const row = document.createElement('div');
    row.className = 'rulerow';
    row.innerHTML = `
      <span class="rulerow__n"></span>
      <div class="rulerow__fields">
        <input class="input" data-rule-title maxlength="90" placeholder="Short rule" value="${attr(rule.title)}" />
        <input class="input input--sm" data-rule-detail maxlength="400" placeholder="Optional detail" value="${attr(rule.detail)}" />
      </div>
      <button class="icon-btn" type="button" data-rule-remove aria-label="Remove rule">${icon('trash', { size: 15 })}</button>`;
    slot.append(row);
    renumber();
  };
  const renumber = () => slot.querySelectorAll('.rulerow__n').forEach((n, i) => { n.textContent = i + 1; });

  DEFAULT_RULES.forEach(addRule);
  qs('#cc-add-rule').addEventListener('click', () => addRule());
  slot.addEventListener('click', (e) => {
    if (!e.target.closest('[data-rule-remove]')) return;
    if (slot.children.length <= 1) return toast('Keep at least one rule.', 'error');
    e.target.closest('.rulerow').remove();
    renumber();
  });

  qs('#create-community').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;

    const rules = [...slot.querySelectorAll('.rulerow')].map((row) => ({
      title: row.querySelector('[data-rule-title]').value.trim(),
      detail: row.querySelector('[data-rule-detail]').value.trim(),
    })).filter((r) => r.title.length >= 3);

    if (!rules.length) {
      btn.disabled = false;
      return toast('Write at least one rule.', 'error');
    }

    try {
      const { slug } = await api.post('/communities', {
        slug: form.slug.value.trim().toLowerCase(),
        name: form.name.value.trim(),
        tagline: form.tagline.value.trim(),
        description: form.description.value.trim(),
        nsfw: form.nsfw.checked,
        rules,
      });
      await loadBoards();
      renderRails();
      toast('Founded. It is yours.', 'ok');
      navigate(`/b/${slug}`);
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
    }
  });
}

async function viewCommunitySettings(slug) {
  const [{ board }, meta] = await Promise.all([
    api.get(`/boards/${encodeURIComponent(slug)}`),
    api.get(`/communities/${encodeURIComponent(slug)}/rules`),
  ]);
  if (!meta.canConfigure) {
    view.innerHTML = emptyState('Not yours to change', 'Only the owner can manage this community.');
    return;
  }

  view.innerHTML = `
    <div class="news-hero">
      <span class="news-hero__kicker">${icon('wrench', { size: 13 })} Manage</span>
      <h1>${esc(board.name)}</h1>
      <p>/b/${esc(board.slug)} — founded ${esc(timeAgo(board.createdAt))}.</p>
    </div>

    <form class="panel form" id="cs-profile">
      <p class="panel__title">Profile</p>
      <div class="field">
        <label class="field__label" for="cs-name">Display name</label>
        <input class="input" id="cs-name" name="name" maxlength="60" value="${attr(board.name)}" />
      </div>
      <div class="field">
        <label class="field__label" for="cs-tagline">Tagline</label>
        <input class="input" id="cs-tagline" name="tagline" maxlength="140" value="${attr(board.tagline)}" />
      </div>
      <div class="field">
        <label class="field__label" for="cs-description">Description</label>
        <textarea class="textarea" id="cs-description" name="description" rows="4" maxlength="2000">${esc(board.description)}</textarea>
      </div>
      <label class="check"><input type="checkbox" name="nsfw" ${board.nsfw ? 'checked' : ''} /> <span>Explicit imagery</span></label>
      <div class="form-actions"><button class="btn btn--primary" type="submit">Save</button></div>
    </form>

    <section class="panel">
      <p class="panel__title">Rules and how often they are used</p>
      <ol class="rules__list">
        ${meta.rules.map((r) => `
          <li class="rule">
            <span class="rule__n">${r.position}</span>
            <span class="rule__body">
              <span class="rule__title">${esc(r.title)}</span>
              ${r.detail ? `<span class="rule__detail">${esc(r.detail)}</span>` : ''}
            </span>
            <span class="rule__cited${r.cited_count ? ' rule__cited--live' : ''}">${num(r.cited_count)}</span>
            <button class="icon-btn" data-retire-rule="${r.id}" title="Retire this rule">${icon('trash', { size: 15 })}</button>
          </li>`).join('')}
      </ol>
      <form class="rulerow" id="cs-add-rule" style="margin-top:12px">
        <span class="rulerow__n">+</span>
        <div class="rulerow__fields">
          <input class="input" name="title" maxlength="90" placeholder="New rule" required />
          <input class="input input--sm" name="detail" maxlength="400" placeholder="Optional detail" />
        </div>
        <button class="btn btn--sm" type="submit">Add</button>
      </form>
      <p class="field__hint" style="margin-top:10px">
        Retiring keeps the rule on past removals — a moderation record pointing at a rule that no
        longer exists is worse than no record.
      </p>
    </section>

    <section class="panel">
      <p class="panel__title">Moderators</p>
      <ul class="modlist">
        ${meta.moderators.map((m) => `
          <li>
            <a href="/u/${attr(m.username)}" data-link>${esc(m.username)}</a>
            <span class="badge ${m.role === 'owner' ? 'badge--admin' : 'badge--mod'}">${esc(m.role)}</span>
            ${m.role === 'owner' ? '' : `<button class="icon-btn" data-drop-mod="${attr(m.username)}" aria-label="Remove">${icon('close', { size: 15 })}</button>`}
          </li>`).join('')}
      </ul>
      <form class="form-actions" id="cs-add-mod" style="margin-top:10px">
        <input class="input" name="username" maxlength="20" placeholder="username" required />
        <button class="btn btn--sm" type="submit">Add moderator</button>
      </form>
    </section>`;

  qs('#cs-profile').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    try {
      await api.patch(`/communities/${encodeURIComponent(slug)}`, {
        name: f.name.value, tagline: f.tagline.value,
        description: f.description.value, nsfw: f.nsfw.checked,
      });
      await loadBoards();
      renderRails();
      toast('Saved.', 'ok');
    } catch (err) { toast(err.message, 'error'); }
  });

  qs('#cs-add-rule').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api.post(`/communities/${encodeURIComponent(slug)}/rules`,
        { title: e.currentTarget.title.value, detail: e.currentTarget.detail.value });
      route();
    } catch (err) { toast(err.message, 'error'); }
  });

  qs('#cs-add-mod').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api.post(`/communities/${encodeURIComponent(slug)}/mods`, { username: e.currentTarget.username.value });
      route();
    } catch (err) { toast(err.message, 'error'); }
  });
}

async function viewTopic(slug) {
  const data = await api.get(`/topics/${encodeURIComponent(slug)}`);
  const { topic } = data;

  view.innerHTML = `
    ${adSlot('top')}
    <div class="news-hero news-hero--topic">
      <span class="news-hero__kicker">${icon('hash', { size: 13 })} Topic</span>
      <h1>${esc(topic.label)}</h1>
      <p>${topic.post_count} ${topic.post_count === 1 ? 'story mentions' : 'stories mention'} this.
         Topics are lifted from what publishers actually filed — nobody curates this list, so it
         tracks coverage rather than opinion.</p>
    </div>
    ${data.items.length
      ? feedList(data.items, feedOpts())
      : emptyState('Nothing filed here yet', 'This topic has no stories in the current window.')}
    ${moreZone(data.nextCursor, `topic:${slug}`)}`;
  observeSentinel();
}

async function viewBoard(slug) {
  const theatre = THEATRE_BOARDS.has(slug);
  // A clip shelf sorts by what is being watched; a thread list sorts by us.
  const sort = theatre && !params().get('sort') ? 'views' : currentSort();

  const [{ board, pinned }, feed] = await Promise.all([
    api.get(`/boards/${encodeURIComponent(slug)}`),
    api.get(`/feed${query({ sort, t: currentWindow(), board: slug, limit: theatre ? 24 : 25 })}`),
  ]);

  const pinnedIds = new Set(pinned.map((p) => p.id));
  const rest = feed.items.filter((p) => !pinnedIds.has(p.id));

  view.innerHTML = `
    ${adSlot('top')}
    <header class="board-head" style="--board-accent:${attr(board.accent)}">
      <div class="board-head__top">
        <div class="board-head__icon">${boardIcon(board.slug, { size: 25 })}</div>
        <div style="flex:1;min-width:0">
          <h1>${esc(board.name)}</h1>
          <p class="board-head__tagline">${esc(board.tagline)}</p>
        </div>
        ${state.me
          ? `<button class="btn btn--sm ${board.subscribed ? '' : 'btn--primary'}" data-subscribe="${attr(board.slug)}">
               ${board.subscribed ? icon('check', { size: 15 }) : icon('plus', { size: 15 })}
               ${board.subscribed ? 'Following' : 'Follow'}
             </button>`
          : ''}
      </div>
      <p class="board-head__desc">${esc(board.description)}</p>
      <div class="board-head__stats">
        <span><b>${num(board.memberCount)}</b> members</span>
        <span><b>${num(board.postCount)}</b> posts</span>
        <span>created ${esc(timeAgo(board.createdAt))}</span>
      </div>
    </header>

    ${rulesPanel(board)}

    ${adSlot('boardHead')}
    ${board.nsfw && (pinned.length || rest.length) ? nsfwBanner() : ''}
    ${composerBar(board.slug)}
    ${newPostsPill()}
    ${sortTabs(sort, { boardSlug: board.slug, theatre })}
    ${pinned.length ? feedList(pinned, feedOpts({ showBoard: false })) : ''}
    ${rest.length
      ? feedList(rest, feedOpts({ showBoard: false, view: theatre ? 'theatre' : state.view }))
      : pinned.length
        ? ''
        : boardEmptyState(board)}
    ${moreZone(feed.nextCursor)}`;
  markWatermark(feed.items);
  observeSentinel();
}

function nsfwBanner() {
  const on = revealsAll();
  return `<div class="nsfw-bar">
    <span class="nsfw-bar__icon">${icon(on ? 'eye' : 'eyeOff', { size: 16 })}</span>
    <span class="nsfw-bar__text">
      Thumbnails on this board are <b>${on ? 'shown' : 'blurred'}</b>.
      ${on ? 'Explicit artwork loads unblurred everywhere.' : 'Tap any card to reveal it, or switch them all on.'}
    </span>
    <button class="btn btn--sm ${on ? '' : 'btn--primary'}" data-reveal-all="${on ? '0' : '1'}">
      ${on ? 'Blur them again' : 'Show all'}
    </button>
  </div>`;
}

/**
 * An empty board is the one place this deployment's network shows through to a
 * reader, so it says which sources feed the board and what happened to them
 * rather than implying nothing was published.
 */
function boardEmptyState(board) {
  // Only enabled sources count: a source the operator switched off is not
  // "blocked", and counting it would misreport some-vs-all.
  const feeding = state.sources.filter((s) => s.board === board.slug && s.enabled);
  const down = feeding.filter((s) => s.lastStatus && s.lastStatus !== 'ok');
  const live = feeding.filter((s) => s.lastStatus === 'ok');
  const start = `<a class="btn btn--primary" href="/submit?board=${attr(board.slug)}" data-link>Start the first thread</a>`;

  if (!feeding.length) {
    return emptyState('Quiet in here', 'No threads on this board yet.', start);
  }

  if (down.length) {
    return `<div class="empty">
      <h2>${down.length === feeding.length ? 'No sources for this board are reachable' : 'Some sources for this board are blocked'}</h2>
      <p>
        ${down.map((s) => esc(s.name)).join(', ')} ${down.length === 1 ? 'is' : 'are'} configured and enabled, but the
        request never leaves this network. Adult domains are routinely intercepted by ISP, campus and workplace
        content filters, which hand back a block page instead of the feed.
      </p>
      <p class="empty__note">Nothing is broken here. Deploy somewhere unfiltered and this fills itself.</p>
      <div class="empty__actions">
        ${start}
        ${isStaff() ? `<button class="btn btn--sm" data-refresh-wire>${icon('radio', { size: 15 })} Retry the wire</button>` : ''}
      </div>
    </div>`;
  }

  // Every feed is healthy, so the board is filtered rather than starved.
  return `<div class="empty">
    <h2>Nothing has been filed here yet</h2>
    <p>
      ${live.map((s) => esc(s.name)).join(', ')} ${live.length === 1 ? 'is' : 'are'} being read, but ${live.length === 1 ? 'it covers' : 'they cover'}
      this subject alongside much else — only items actually about it get filed here, so the board stays on topic
      and goes quiet when coverage does.
    </p>
    <p class="empty__note">Start the conversation yourself; it does not have to wait for the press.</p>
    <div class="empty__actions">${start}</div>
  </div>`;
}

async function viewNews() {
  const data = await api.get(`/news${query({ limit: 21 })}`);

  // A newsroom picks its lead partly for the art. Prefer the newest story that
  // actually has a picture, but never reach past the top few to find one.
  const leadIndex = Math.max(0, data.items.slice(0, 4).findIndex((p) => p.img || p.videoKind));
  const lead = data.items[leadIndex];
  const rest = data.items.filter((_, i) => i !== leadIndex);
  const grid = rest.slice(0, 4);
  const remainder = rest.slice(4);

  view.innerHTML = `
    <div class="news-hero">
      <span class="news-hero__kicker">${icon('newspaper', { size: 13 })} The Newsroom</span>
      <h1>What is actually happening in the adult industry</h1>
      <p>Staff reporting plus headlines from the trade press — regulation, platforms, labour, money
         and technology. Every story is open for discussion.</p>
    </div>

    ${lead ? newsLead(lead) : ''}
    ${grid.length ? newsGrid(grid) : ''}
    ${remainder.length ? sectionHead('More from the wire', 'trendingUp') + feedList(remainder, feedOpts({ view: 'compact' })) : ''}

    ${!data.items.length
      ? emptyState('The wire is quiet', 'No stories have been published yet.')
      : ''}
    ${isStaff()
      ? `<div style="margin-top:16px"><button class="btn btn--sm" data-refresh-wire>
           ${icon('trendingUp', { size: 15 })} Pull trade feeds now
         </button></div>`
      : ''}
    ${moreZone(data.nextCursor, 'news')}`;
  observeSentinel();
}

async function viewSaved() {
  if (!state.me) {
    view.innerHTML = emptyState('Sign in first', 'Saved posts live with your account.',
      '<button class="btn btn--primary" data-auth="login">Sign in</button>');
    return;
  }
  const { items } = await api.get('/saved');
  view.innerHTML = `
    <div class="news-hero">
      <span class="news-hero__kicker">${icon('bookmark', { size: 13 })} Saved</span>
      <h1>${items.length} saved ${items.length === 1 ? 'thread' : 'threads'}</h1>
      <p>Anything you bookmark lands here. Nobody else can see this list.</p>
    </div>
    ${items.length
      ? feedList(items, feedOpts())
      : emptyState('Nothing saved yet', 'Hit Save on any thread and it turns up here.')}`;
}

function communityCard(c) {
  if (!c) return '';
  return `<section class="panel commcard" style="--board-accent:${attr(c.accent)}">
    <a class="commcard__head" href="/b/${attr(c.slug)}" data-link>
      <span class="comm__icon">${boardIcon(c.slug, { size: 18 })}</span>
      <span class="comm__names">
        <span class="comm__name">${esc(c.name)}</span>
        <span class="comm__slug">/b/${esc(c.slug)}</span>
      </span>
    </a>
    ${c.tagline ? `<p class="commcard__tagline">${esc(c.tagline)}</p>` : ''}
    <div class="comm__stats">
      <span><b>${num(c.memberCount)}</b> members</span>
      <span><b>${num(c.postCount)}</b> posts</span>
    </div>
    ${state.me ? `<button class="btn btn--sm btn--block ${c.subscribed ? '' : 'btn--primary'}"
      data-subscribe="${attr(c.slug)}">${c.subscribed ? 'Joined' : 'Join'}</button>` : ''}
    ${c.rules.length ? `
      <p class="panel__title" style="margin:14px 0 6px">Rules</p>
      <ol class="commcard__rules">
        ${c.rules.map((r) => `<li><span>${r.position}</span>${esc(r.title)}${
          r.cited_count ? ` <b title="times cited in a removal">${r.cited_count}</b>` : ''}</li>`).join('')}
      </ol>` : ''}
    ${c.moderators.length ? `<p class="commcard__mods">Moderated by ${c.moderators
      .map((m) => `<a href="/u/${attr(m.username)}" data-link>${esc(m.username)}</a>`).join(', ')}</p>` : ''}
  </section>`;
}

async function viewPost(id) {
  const sort = params().get('sort') || 'best';
  const data = await api.get(`/posts/${id}${query({ sort })}`);
  const post = data.post;
  state.currentPost = post;

  const source = (post.kind === 'article' && post.sourceUrl) || (post.kind === 'link' && post.url)
    ? `<a class="post__source" href="${attr(post.sourceUrl || post.url)}" rel="noopener nofollow ugc" target="_blank">
         ${icon('link', { size: 13 })}
         <span>Read at ${esc(post.source || hostOf(post.sourceUrl || post.url))}</span>
         ${icon('externalLink', { size: 13 })}
       </a>`
    : '';

  const hero = post.img || post.videoKind
    ? `<div class="detail__hero">${media(post, 'hero')}</div>`
    : '';

  // The card lives in the right rail rather than under the post: beside the
  // thread it is visible for the whole read, under it only at the very end.
  state.railExtra = communityCard(data.community);
  renderRightRail();

  view.innerHTML = `
    <article class="card detail" data-post-id="${post.id}">
      ${hero}
      <div class="detail__head">
        ${voteColumn(post)}
        <div class="detail__body">
          <div class="post__meta">
            <a class="post__board" href="/b/${attr(post.board.slug)}" data-link style="--board-accent:${attr(post.board.accent)}">
              ${boardIcon(post.board.slug, { size: 14 })}${esc(post.board.name)}
            </a>
            <span>${post.author === '[deleted]'
              ? `<span class="source-pill">${esc(post.source || 'AfterDark Wire')}</span>`
              : `<a href="/u/${attr(post.author)}" data-link>${esc(post.author)}</a>`}</span>
            <span>·</span>
            <time title="${attr(fullDate(post.createdAt))}">${timeAgo(post.createdAt)}</time>
            ${post.editedAt ? '<span>· edited</span>' : ''}
            ${post.readingMinutes && post.kind === 'text' ? `<span>· ${post.readingMinutes} min read</span>` : ''}
            ${post.flair ? `<span class="flair">${esc(post.flair)}</span>` : ''}
            ${post.locked ? '<span class="badge badge--removed">locked</span>' : ''}
          </div>

          <h1 class="post__title">${esc(post.title)}</h1>
          ${source}
          ${post.duration || post.views ? `
            <div class="detail__stats">
              ${post.duration ? `<span>${icon('clock', { size: 14 })} ${esc(runtime(post.duration))}</span>` : ''}
              ${post.views ? `<span>${icon('eye', { size: 14 })} ${num(post.views)} views at source</span>` : ''}
            </div>` : ''}
          ${post.removed
            ? `<div class="form-note">This post was removed${post.removedReason ? `: ${esc(post.removedReason)}` : '.'}</div>`
            : `<div class="prose" data-post-body>${markdown(post.body)}</div>`}
          ${topicChips(post, 6)}
          ${reactionBar(post)}

          <div class="post__actions" style="margin-top:16px">
            <span class="action">${icon('comment', { size: 16 })} ${num(post.commentCount)}</span>
            <button class="action" data-save="${post.id}" data-on="${post.saved ? 'true' : 'false'}">
              ${icon('bookmark', { size: 16 })} ${post.saved ? 'Saved' : 'Save'}
            </button>
            <button class="action" data-share="${post.id}">${icon('share', { size: 16 })} Share</button>
            ${post.canEdit && post.kind === 'text' && !post.removed ? `<button class="action" data-edit-post="${post.id}">${icon('edit', { size: 16 })} Edit</button>` : ''}
            ${post.canEdit && !post.removed ? `<button class="action" data-delete-post="${post.id}">${icon('trash', { size: 16 })}</button>` : ''}
            <button class="action" data-report-post="${post.id}">${icon('flag', { size: 16 })}</button>
            ${isStaff() ? `<button class="action" data-mod-post="${post.id}">${icon('shield', { size: 16 })}</button>` : ''}
          </div>
        </div>
      </div>
    </article>

    ${adSlot('article')}

    <section class="comments">
      ${post.locked
        ? '<div class="form-note">This thread is locked. No new comments.</div>'
        : state.me
          ? `<form class="panel composer" data-comment-form>
               <textarea class="textarea" name="body" placeholder="Add to the discussion. Markdown works." required></textarea>
               <div class="form-actions" style="margin-top:10px">
                 <button class="btn btn--primary btn--sm" type="submit">Comment</button>
                 <span class="field__hint">Be specific. Cite sources where you have them.</span>
               </div>
             </form>`
          : `<div class="panel" style="text-align:center">
               <p style="margin:0 0 10px;color:var(--text-dim);font-size:14px">Sign in to join the discussion.</p>
               <button class="btn btn--primary btn--sm" data-auth="login">Sign in</button>
             </div>`}

      <div class="comments__head">
        <span class="comments__count">${num(data.commentTotal)} comments</span>
        <span class="tabs__spacer"></span>
        <select class="select" data-comment-sort>
          ${['best', 'top', 'new', 'old', 'controversial']
            .map((s) => `<option value="${s}" ${s === data.commentSort ? 'selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`)
            .join('')}
        </select>
      </div>

      <div data-comment-root>${commentTree(data.comments, post.author)}</div>
      ${adSlot('commentsMid')}
      ${data.truncated ? '<p class="loader">Only the first 800 comments are shown.</p>' : ''}
    </section>

    ${adSlot('comments')}

    ${data.related?.length
      ? adSlot('related') + sectionHead(`More from ${post.board.name}`, 'layers') + feedList(data.related, feedOpts({ view: 'compact', showBoard: false, ads: false }))
      : ''}`;
}

async function viewProfile(username) {
  const data = await api.get(`/users/${encodeURIComponent(username)}`);
  const p = data.profile;

  view.innerHTML = `
    <header class="profile-head">
      <div class="profile-head__avatar" style="${attr(avatarStyle(p.username))}">${esc(initials(p.username))}</div>
      <div style="flex:1;min-width:0">
        <h1>${esc(p.username)}</h1>
        <div class="profile-karma">
          <span><b>${num(p.postKarma)}</b> post karma</span>
          <span><b>${num(p.commentKarma)}</b> comment karma</span>
          <span>joined ${esc(timeAgo(p.createdAt))}</span>
        </div>
        ${p.bio ? `<p class="profile-head__bio">${esc(p.bio)}</p>` : ''}
      </div>
      ${p.suspended ? '<span class="badge badge--removed">suspended</span>' : ''}
    </header>

    <div class="tabs" role="tablist">
      <button class="tab" role="tab" aria-selected="true" data-profile-tab="posts">${icon('layers', { size: 15 })} Posts</button>
      <button class="tab" role="tab" aria-selected="false" data-profile-tab="comments">${icon('comment', { size: 15 })} Comments</button>
    </div>

    <div data-profile-panel="posts">
      ${data.posts.length ? feedList(data.posts, feedOpts()) : emptyState('No posts', `${p.username} has not posted yet.`)}
    </div>

    <div data-profile-panel="comments" hidden>
      ${data.comments.length
        ? data.comments.map((c) => `
        <a class="panel" style="display:block;margin-bottom:8px" href="/p/${c.post_id}" data-link>
          <div class="post__meta">on <b>${esc(c.post_title)}</b> · ${esc(timeAgo(c.created_at))} · ${num(c.score)} points</div>
          <div class="comment__text prose">${markdown(c.body)}</div>
        </a>`).join('')
        : emptyState('No comments', `${p.username} has not commented yet.`)}
    </div>`;
}

/**
 * Search, with the tabs Reddit ships: posts, communities, people.
 *
 * Communities and people are matched client-side against sets we already hold —
 * the board list is a dozen rows and the people search hits an endpoint only
 * when it has to, which is cheaper than a second full-text index for something
 * used far less than post search.
 */
async function viewSearch() {
  const q = params().get('q') || '';
  const tab = ['posts', 'communities', 'people'].includes(params().get('tab')) ? params().get('tab') : 'posts';
  qs('#search-input').value = q;

  if (q.length < 2) {
    view.innerHTML = emptyState('Search AfterDark', 'Type at least two characters.');
    return;
  }

  const needle = q.toLowerCase();
  const communities = state.boards.filter((b) =>
    b.name.toLowerCase().includes(needle) || b.slug.toLowerCase().includes(needle)
    || (b.tagline || '').toLowerCase().includes(needle));

  const data = tab === 'posts' ? await api.get(`/search${query({ q })}`) : { items: [] };
  const people = tab === 'people' ? await api.get(`/users/search${query({ q })}`).catch(() => ({ users: [] })) : { users: [] };

  const counts = { posts: data.items.length, communities: communities.length, people: people.users?.length || 0 };
  const tabLink = (key, label) => `<a class="tab" role="tab" aria-selected="${key === tab}"
    href="/search?q=${encodeURIComponent(q)}&tab=${key}" data-link>${label}${
      key === tab ? ` <span class="tab__n">${counts[key]}</span>` : ''}</a>`;

  let body;
  if (tab === 'communities') {
    body = communities.length
      ? `<div class="commgrid">${communities.map((c) => `
          <article class="comm" style="--board-accent:${attr(c.accent)}">
            <a class="comm__head" href="/b/${attr(c.slug)}" data-link>
              <span class="comm__icon">${boardIcon(c.slug, { size: 18 })}</span>
              <span class="comm__names">
                <span class="comm__name">${esc(c.name)}</span>
                <span class="comm__slug">/b/${esc(c.slug)}</span>
              </span>
            </a>
            ${c.tagline ? `<p class="comm__tagline">${esc(c.tagline)}</p>` : ''}
            <div class="comm__stats"><span><b>${num(c.memberCount)}</b> members</span><span><b>${num(c.postCount)}</b> posts</span></div>
          </article>`).join('')}</div>`
      : emptyState('No communities matched', 'Try a shorter word.');
  } else if (tab === 'people') {
    body = people.users?.length
      ? `<ul class="peoplelist">${people.users.map((u) => `
          <li><a href="/u/${attr(u.username)}" data-link>
            <span class="comment__avatar" style="${attr(avatarStyle(u.username))}">${esc(initials(u.username))}</span>
            <span><b>${esc(u.username)}</b><span>${num(u.postKarma + u.commentKarma)} karma · joined ${esc(timeAgo(u.createdAt))}</span></span>
          </a></li>`).join('')}</ul>`
      : emptyState('No accounts matched', 'Usernames only — profiles are not full-text searched.');
  } else {
    body = data.items.length ? feedList(data.items, feedOpts())
      : emptyState('Nothing matched', 'Try fewer or different words.');
  }

  view.innerHTML = `
    ${adSlot('top')}
    <div class="news-hero news-hero--slim">
      <span class="news-hero__kicker">${icon('search', { size: 13 })} Search</span>
      <h1>${esc(q)}</h1>
    </div>
    <div class="tabs tabs--sticky" role="tablist">
      ${tabLink('posts', 'Posts')}${tabLink('communities', 'Communities')}${tabLink('people', 'People')}
    </div>
    ${body}`;
}


async function viewSubmit() {
  if (!state.me) {
    view.innerHTML = emptyState('Sign in first', 'You need an account to post.',
      '<button class="btn btn--primary" data-auth="login">Sign in</button>');
    return;
  }

  const preselect = params().get('board') || '';
  const postable = state.boards.filter((b) => b.kind !== 'news' || isStaff());

  view.innerHTML = `
    <div class="news-hero">
      <span class="news-hero__kicker">${icon('plus', { size: 13 })} New thread</span>
      <h1>Start a discussion</h1>
      <p>Text and links only. Link posts pull in the page's own preview image automatically.</p>
    </div>

    <form class="panel" data-submit-form>
      <div class="form-error" data-error hidden></div>

      <div class="field">
        <label class="field__label" for="submit-board">Board</label>
        <select class="input" id="submit-board" name="board" required>
          ${postable.map((b) => `<option value="${attr(b.slug)}" ${b.slug === preselect ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}
        </select>
      </div>

      <div class="tabs" style="margin-bottom:14px">
        <button class="tab" type="button" role="tab" aria-selected="true" data-kind="text">${icon('edit', { size: 15 })} Text post</button>
        <button class="tab" type="button" role="tab" aria-selected="false" data-kind="link">${icon('link', { size: 15 })} Link</button>
      </div>

      <div class="field">
        <label class="field__label" for="submit-title">Title</label>
        <input class="input" id="submit-title" name="title" maxlength="300" required
               placeholder="Say what the thread is about" />
      </div>

      <div class="field" data-field="url" hidden>
        <label class="field__label" for="submit-url">Link</label>
        <input class="input" id="submit-url" name="url" type="url" placeholder="https://" />
        <span class="field__hint">Reporting, a primary source, or a video. YouTube and Vimeo links become players.</span>
      </div>

      <div class="field" data-field="body">
        <label class="field__label" for="submit-body">Body</label>
        <textarea class="textarea" id="submit-body" name="body" rows="10" maxlength="20000"
                  placeholder="Markdown works: **bold**, *italic*, &gt; quote, - list, ### heading"></textarea>
      </div>

      <div class="field">
        <label class="field__label" for="submit-flair">Flair <span style="text-transform:none">(optional)</span></label>
        <input class="input" id="submit-flair" name="flair" maxlength="32" placeholder="Analysis, Question, PSA…" />
      </div>

      <div class="form-note">
        Submissions are screened automatically. Anything involving minors or non-consensual material is
        rejected at submission and logged.
      </div>

      <div class="form-actions">
        <button class="btn btn--primary" type="submit">Post</button>
        <a class="btn btn--ghost" href="/" data-link>Cancel</a>
      </div>
    </form>`;
}

async function viewMod() {
  if (!isStaff()) {
    view.innerHTML = emptyState('Staff only', 'This page is for moderators.');
    return;
  }
  const data = await api.get('/mod/queue');

  view.innerHTML = `
    <div class="news-hero">
      <span class="news-hero__kicker">${icon('shield', { size: 13 })} Moderation</span>
      <h1>${data.queue.length} open report${data.queue.length === 1 ? '' : 's'}</h1>
      <p>Reports are ordered newest first. Removals are logged and visible to all staff.</p>
    </div>

    ${data.queue.length
      ? data.queue.map((r) => `
      <div class="report" data-report="${r.id}">
        <div class="report__reason">${esc(r.reason)}</div>
        <div class="report__meta">
          ${esc(r.target_type)} #${r.target_id} · reported by ${esc(r.reporter || 'auto-filter')} · ${esc(timeAgo(r.created_at))}
          ${r.detail ? ` · ${esc(r.detail)}` : ''}
        </div>
        <div class="report__target">
          ${r.target
            ? `<b>${esc(r.target.title || '')}</b><div>${esc((r.target.body || '').slice(0, 600))}</div>
               <div style="margin-top:6px;font-size:12px;color:var(--text-faint)">by ${esc(r.target.author || '?')}</div>`
            : '<em>Target no longer exists.</em>'}
        </div>
        <div class="form-actions">
          ${r.target_type === 'post' ? `<a class="btn btn--sm btn--ghost" href="/p/${r.target_id}" data-link>Open</a>` : ''}
          <button class="btn btn--sm btn--danger" data-mod-action="remove" data-type="${esc(r.target_type)}" data-id="${r.target_id}" data-report-id="${r.id}">Remove</button>
          ${r.target_type === 'post'
            ? `<button class="btn btn--sm" data-mod-action="lock" data-type="post" data-id="${r.target_id}" data-report-id="${r.id}">Lock</button>`
            : ''}
          <button class="btn btn--sm btn--ghost" data-dismiss="${r.id}">Dismiss</button>
        </div>
      </div>`).join('')
      : emptyState('Queue is clear', 'No open reports.')}

    <section class="panel" style="margin-top:18px">
      <p class="panel__title">Recent moderator actions</p>
      ${data.log.length
        ? data.log.map((l) => `<div style="font-size:12.5px;color:var(--text-dim);padding:5px 0;border-bottom:1px solid var(--line-soft)">
             <b>${esc(l.actor || 'system')}</b> ${esc(l.action)} ${esc(l.target_type)} #${l.target_id}
             <span style="color:var(--text-faint)">· ${esc(timeAgo(l.created_at))}</span>
             ${l.reason ? `<div style="color:var(--text-faint)">${esc(l.reason)}</div>` : ''}
           </div>`).join('')
        : '<p class="field__hint">Nothing logged yet.</p>'}
    </section>`;
}

// ---------------------------------------------------------------------------
// Infinite scroll
// ---------------------------------------------------------------------------

function moreZone(cursor, kind = 'feed') {
  if (!cursor) return '';
  return `<div style="margin-top:16px">
    <button class="btn btn--block" data-load-more="${attr(cursor)}" data-kind="${kind}">Load more</button>
    <div class="sentinel" data-sentinel></div>
  </div>`;
}

let sentinelObserver = null;

/**
 * Auto-load the next page as the reader nears the bottom, while leaving the
 * button in place — NN/g's point is that a pure infinite feed strands anyone
 * who wants the footer or keyboard access.
 */
function observeSentinel() {
  sentinelObserver?.disconnect();
  const sentinel = view.querySelector('[data-sentinel]');
  if (!sentinel) return;

  sentinelObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const button = view.querySelector('[data-load-more]');
      if (button && !state.feedLoading) loadMore(button);
    }
  }, { rootMargin: '900px 0px' });

  sentinelObserver.observe(sentinel);
}

async function loadMore(button) {
  if (state.feedLoading) return;
  state.feedLoading = true;
  button.disabled = true;
  button.textContent = 'Loading…';

  try {
    const cursor = button.dataset.loadMore;
    const kind = button.dataset.kind;
    const boardSlug = location.pathname.startsWith('/b/') ? location.pathname.split('/')[2] : '';
    const theatre = THEATRE_BOARDS.has(boardSlug);

    let path;
    if (kind === 'news') {
      path = `/news${query({ cursor, limit: 20 })}`;
    } else if (kind.startsWith('cfeed:')) {
      path = `/feeds/${encodeURIComponent(kind.slice(6))}/posts${query({ cursor, sort: currentSort() })}`;
    } else if (kind.startsWith('topic:')) {
      path = `/topics/${encodeURIComponent(kind.slice(6))}${query({ cursor })}`;
    } else {
      path = `/feed${query({
        sort: theatre && !params().get('sort') ? 'views' : currentSort(),
        t: currentWindow(),
        cursor,
        limit: theatre ? 24 : 25,
        board: boardSlug,
        scope: params().get('scope') === 'subscribed' ? 'subscribed' : '',
      })}`;
    }

    const data = await api.get(path);
    const showBoard = !boardSlug;
    const holder = document.createElement('div');
    holder.innerHTML = feedList(data.items, feedOpts({ showBoard, view: theatre ? 'theatre' : state.view }));
    const feed = holder.firstElementChild;

    const lastFeed = [...view.querySelectorAll('.feed')].pop();
    if (feed && lastFeed) {
      // A break between pages is the least intrusive place in an endless list:
      // the reader has just chosen to continue.
      lastFeed.insertAdjacentHTML('beforeend', adSlot('page', { className: 'adslot--feed' }));
      lastFeed.append(...feed.children);
    }
    observeReveals(lastFeed || view);

    if (data.nextCursor) {
      button.dataset.loadMore = data.nextCursor;
      button.disabled = false;
      button.textContent = 'Load more';
    } else {
      button.closest('div')?.remove();
      sentinelObserver?.disconnect();
    }
  } catch (err) {
    toast(err.message, 'error');
    button.disabled = false;
    button.textContent = 'Load more';
  } finally {
    state.feedLoading = false;
  }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function authModal(mode = 'login') {
  const isRegister = mode === 'register';
  openModal(`
    <button class="icon-btn modal__close" data-close aria-label="Close">${icon('close', { size: 18 })}</button>
    <h2>${isRegister ? 'Join AfterDark' : 'Welcome back'}</h2>
    <p class="modal__sub">${isRegister
      ? 'Pick a name you are happy to be known by. No email required — we do not want one.'
      : 'Sign in to vote, comment and post.'}</p>
    <form data-auth-form data-mode="${mode}">
      <div class="form-error" data-error hidden></div>
      <div class="field">
        <label class="field__label" for="auth-user">Username</label>
        <input class="input" id="auth-user" name="username" autocomplete="username" required
               minlength="3" maxlength="20" pattern="[a-zA-Z0-9][a-zA-Z0-9_\\-]{2,19}"
               title="3–20 characters: letters, numbers, underscore and hyphen." />
      </div>
      <div class="field">
        <label class="field__label" for="auth-pass">Password</label>
        <input class="input" id="auth-pass" name="password" type="password" required minlength="10"
               autocomplete="${isRegister ? 'new-password' : 'current-password'}" />
        ${isRegister ? '<span class="field__hint">At least 10 characters. There is no password reset — write it down.</span>' : ''}
      </div>
      <div class="form-actions">
        <button class="btn btn--primary" type="submit">${isRegister ? 'Create account' : 'Sign in'}</button>
        <button class="btn btn--ghost" type="button" data-auth="${isRegister ? 'login' : 'register'}">
          ${isRegister ? 'I already have an account' : 'Create an account'}
        </button>
      </div>
    </form>`);
}

async function submitAuth(form) {
  const mode = form.dataset.mode;
  const errorBox = form.querySelector('[data-error]');
  const button = form.querySelector('button[type=submit]');
  errorBox.hidden = true;
  button.disabled = true;

  try {
    const { user } = await api.post(`/auth/${mode}`, {
      username: form.username.value.trim(),
      password: form.password.value,
    });
    state.me = user;
    closeModal();
    renderTopbarNav();
    toast(mode === 'register' ? `Welcome, ${user.username}.` : `Signed in as ${user.username}.`, 'ok');
    await Promise.all([loadBoards(), loadStats()]);
    renderRails();
    route();
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.hidden = false;
    button.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

async function reportModal(targetType, targetId) {
  if (!state.me) return authModal('login');
  const { reasons } = await api.get('/report/reasons');

  openModal(`
    <button class="icon-btn modal__close" data-close aria-label="Close">${icon('close', { size: 18 })}</button>
    <h2>Report this ${esc(targetType)}</h2>
    <p class="modal__sub">Reports go to a human moderator. Reporting is anonymous to other users.</p>
    <form data-report-form data-type="${esc(targetType)}" data-id="${targetId}">
      <div class="form-error" data-error hidden></div>
      <div class="field">
        <label class="field__label" for="report-reason">Reason</label>
        <select class="input" id="report-reason" name="reason" required>
          ${reasons.map((r) => `<option>${esc(r)}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label class="field__label" for="report-detail">Detail <span style="text-transform:none">(optional)</span></label>
        <textarea class="textarea" id="report-detail" name="detail" maxlength="1000" rows="4"></textarea>
      </div>
      <div class="form-note">
        If this involves a minor, also report it to the authorities in your country. In the US:
        CyberTipline, report.cybertip.org.
      </div>
      <div class="form-actions">
        <button class="btn btn--primary" type="submit">Send report</button>
        <button class="btn btn--ghost" type="button" data-close>Cancel</button>
      </div>
    </form>`);
}

function shortcutsModal() {
  openModal(`
    <button class="icon-btn modal__close" data-close aria-label="Close">${icon('close', { size: 18 })}</button>
    <h2>Keyboard shortcuts</h2>
    <p class="modal__sub">Because scrolling with a mouse is not a personality.</p>
    <div class="keys">
      <kbd>j</kbd><span>Next post</span>
      <kbd>k</kbd><span>Previous post</span>
      <kbd>Enter</kbd><span>Open the selected post</span>
      <kbd>u</kbd><span>Upvote the selected post</span>
      <kbd>d</kbd><span>Downvote the selected post</span>
      <kbd>s</kbd><span>Save the selected post</span>
      <kbd>/</kbd><span>Focus search</span>
      <kbd>g</kbd><span>then <kbd>h</kbd> home · <kbd>n</kbd> newsroom · <kbd>s</kbd> saved</span>
      <kbd>v</kbd><span>Cycle card / compact / classic</span>
      <kbd>?</kbd><span>This list</span>
    </div>`);
}

// ---------------------------------------------------------------------------
// Keyboard navigation
// ---------------------------------------------------------------------------

let cursorIndex = -1;
let pendingG = false;

function posts() {
  return [...view.querySelectorAll('.post, .newslead, .newscard')];
}

function moveCursor(delta) {
  const list = posts();
  if (!list.length) return;
  list[cursorIndex]?.style.removeProperty('outline');
  cursorIndex = Math.max(0, Math.min(list.length - 1, cursorIndex + delta));
  const el = list[cursorIndex];
  el.style.outline = '2px solid var(--accent)';
  el.style.outlineOffset = '2px';
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function selected() {
  return posts()[cursorIndex] || null;
}

document.addEventListener('keydown', (event) => {
  const tag = event.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target.isContentEditable) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (!state.ageOk) return;

  if (pendingG) {
    pendingG = false;
    if (event.key === 'h') return navigate('/');
    if (event.key === 'n') return navigate('/news');
    if (event.key === 's') return navigate('/saved');
  }

  switch (event.key) {
    case 'j': event.preventDefault(); moveCursor(1); break;
    case 'k': event.preventDefault(); moveCursor(-1); break;
    case 'g': pendingG = true; setTimeout(() => { pendingG = false; }, 900); break;
    case '/':
      event.preventDefault();
      qs('#search-input').focus();
      break;
    case '?':
      if (!isModalOpen()) shortcutsModal();
      break;
    case 'v': {
      event.preventDefault();
      const next = VIEWS[(VIEWS.indexOf(state.view) + 1) % VIEWS.length];
      setView(next);
      break;
    }
    case 'Enter': {
      const el = selected();
      const link = el?.querySelector('a[data-link][href^="/p/"]') || (el?.matches('a[data-link]') ? el : null);
      if (link) { event.preventDefault(); navigate(link.getAttribute('href')); }
      break;
    }
    case 'u': case 'd': {
      const el = selected();
      const btn = el?.querySelector(`[data-vote="${event.key === 'u' ? 1 : -1}"]`);
      if (btn) { event.preventDefault(); btn.click(); }
      break;
    }
    case 's': {
      const el = selected();
      const btn = el?.querySelector('[data-save]');
      if (btn) { event.preventDefault(); btn.click(); }
      break;
    }
    default: break;
  }
});

function setView(next) {
  state.view = next;
  localStorage.setItem('ad:view', next);
  cursorIndex = -1;
  route();
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const THEME_KEY = 'ad:theme';
const THEME_COLOR = { light: '#eef0ee', dark: '#000000' };

/** What is actually on screen right now, stored choice or OS preference. */
function activeTheme() {
  const set = document.documentElement.getAttribute('data-theme');
  if (set === 'light' || set === 'dark') return set;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function setTheme(next) {
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem(THEME_KEY, next); } catch { /* private mode */ }
  document.getElementById('theme-color')?.setAttribute('content', THEME_COLOR[next]);
  const btn = document.getElementById('theme-toggle');
  btn?.setAttribute('aria-label', next === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme');
}

/** Follow the OS while the reader has expressed no preference of their own. */
function watchSystemTheme() {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', () => {
    let stored = null;
    try { stored = localStorage.getItem(THEME_KEY); } catch { /* ignore */ }
    if (stored) return;
    document.getElementById('theme-color')?.setAttribute('content', THEME_COLOR[activeTheme()]);
  });
  document.getElementById('theme-color')?.setAttribute('content', THEME_COLOR[activeTheme()]);
}

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

let openPickerFor = null;
let awardTargetId = null;

function closeAwardPicker() {
  document.querySelector('.award-picker')?.remove();
  awardTargetId = null;
}

function closeReactPicker() {
  document.querySelector('.react-picker')?.remove();
  openPickerFor = null;
}

function toggleReactPicker(trigger) {
  const bar = trigger.closest('[data-reactions]');
  if (openPickerFor === bar) return closeReactPicker();
  closeReactPicker();
  openPickerFor = bar;
  trigger.insertAdjacentHTML('afterend', reactionPicker());
}

/**
 * Repaint every copy of one post's reaction row. The same post can be on screen
 * twice — in the feed and in the "more from this board" strip — and they must
 * not disagree.
 */
function repaintReactions(id, counts, justToggled) {
  document.querySelectorAll(`[data-reactions="${id}"]`).forEach((bar) => {
    const wasMine = bar.querySelector(`[data-react="${CSS.escape(justToggled)}"]`)?.classList.contains('reaction--mine');
    const mine = new Set(
      [...bar.querySelectorAll('.reaction--mine')].map((b) => b.dataset.react)
    );
    if (wasMine) mine.delete(justToggled);
    else mine.add(justToggled);

    bar.outerHTML = reactionBar({ id, reactions: counts, myReactions: [...mine] });
  });
}

// ---------------------------------------------------------------------------
// Event delegation
// ---------------------------------------------------------------------------

document.addEventListener('click', async (event) => {
  const target = event.target;

  // Video facade → real player. Runs before link handling: the poster sits
  // inside an anchor, and clicking play must not navigate.
  const playBtn = target.closest('[data-play]');
  if (playBtn) {
    event.preventDefault();
    event.stopPropagation();
    playVideo(playBtn.closest('.media'), playBtn.dataset.play, playBtn.dataset.video);
    return;
  }

  // Explicit-image reveal. Swaps the blurred rendition for the sharp one that
  // already travelled with the payload, so there is no round trip and no wait.
  // Reddit's expando: the thumbnail grows into a banner in place. No fetch, no
  // navigation, no lost scroll position — the larger rendition's URL already
  // travelled with the payload.
  const awardOpen = target.closest('[data-award-open]');
  if (awardOpen) {
    event.preventDefault();
    event.stopPropagation();
    if (!state.me) return authModal('login');
    if (document.querySelector('.award-picker')) return closeAwardPicker();
    closeAwardPicker();
    try {
      const { catalogue, remaining } = await api.get('/awards');
      awardOpen.insertAdjacentHTML('afterend', awardPicker(catalogue, remaining));
      awardTargetId = Number(awardOpen.dataset.awardOpen);
    } catch (err) { toast(err.message, 'error'); }
    return;
  }

  const giveAward = target.closest('[data-give-award]');
  if (giveAward) {
    event.preventDefault();
    event.stopPropagation();
    const award = giveAward.dataset.giveAward;
    closeAwardPicker();
    try {
      await api.post('/awards', { targetType: 'post', targetId: awardTargetId, award });
      toast('Given.', 'ok');
      route();
    } catch (err) { toast(err.message, 'error'); }
    return;
  }
  closeAwardPicker();

  const adDismiss = target.closest('[data-ad-dismiss]');
  if (adDismiss) {
    event.preventDefault();
    const slot = adDismiss.closest('[data-adslot]');
    dismissAd(slot?.dataset.adslot);
    slot?.remove();
    return;
  }

  const readAll = target.closest('[data-read-all]');
  if (readAll) {
    event.preventDefault();
    await api.post('/inbox/read').catch(() => {});
    await refreshMe();
    renderTopbarNav();
    route();
    return;
  }

  const blockBtn = target.closest('[data-block]');
  if (blockBtn) {
    event.preventDefault();
    try {
      await api.post(`/block/${encodeURIComponent(blockBtn.dataset.block)}`);
      toast('Blocked. Their posts are hidden and they cannot message you.', 'ok');
      route();
    } catch (err) { toast(err.message, 'error'); }
    return;
  }

  const unblockBtn = target.closest('[data-unblock]');
  if (unblockBtn) {
    event.preventDefault();
    try {
      await api.del(`/block/${encodeURIComponent(unblockBtn.dataset.unblock)}`);
      route();
    } catch (err) { toast(err.message, 'error'); }
    return;
  }

  const dropFeed = target.closest('[data-drop-feed]');
  if (dropFeed) {
    event.preventDefault();
    try {
      await api.del(`/feeds/${encodeURIComponent(dropFeed.dataset.dropFeed)}`);
      await refreshMe();
      renderRails();
      route();
    } catch (err) { toast(err.message, 'error'); }
    return;
  }

  const retireBtn = target.closest('[data-retire-rule]');
  if (retireBtn) {
    event.preventDefault();
    const slug = location.pathname.split('/')[2];
    try {
      await api.del(`/communities/${encodeURIComponent(slug)}/rules/${retireBtn.dataset.retireRule}`);
      toast('Retired. Past removals still cite it.', 'ok');
      route();
    } catch (err) { toast(err.message, 'error'); }
    return;
  }

  const dropMod = target.closest('[data-drop-mod]');
  if (dropMod) {
    event.preventDefault();
    const slug = location.pathname.split('/')[2];
    try {
      await api.del(`/communities/${encodeURIComponent(slug)}/mods/${encodeURIComponent(dropMod.dataset.dropMod)}`);
      route();
    } catch (err) { toast(err.message, 'error'); }
    return;
  }

  const siteLink = target.closest('[data-site]');
  if (siteLink) {
    // Fire and forget — never delay the reader's click on the answer.
    navigator.sendBeacon?.(`/api/sites/${siteLink.dataset.site}/click`) ||
      api.post(`/sites/${siteLink.dataset.site}/click`).catch(() => {});
    return;
  }

  const expandBtn = target.closest('[data-expand]');
  if (expandBtn) {
    event.preventDefault();
    event.stopPropagation();
    const post = expandBtn.closest('.post');
    const open = post.classList.toggle('post--expanded');
    expandBtn.setAttribute('aria-expanded', String(open));
    expandBtn.setAttribute('aria-label', open ? 'Collapse image' : 'Expand image');

    const img = expandBtn.querySelector('img');
    const card = expandBtn.dataset.card;
    // Only upgrade the resolution when it is actually being shown large, and
    // never on a gated thumbnail — that is the reader's call, not ours.
    if (img && card && open && !expandBtn.querySelector('.media--gated')) {
      if (!img.dataset.thumbSrc) img.dataset.thumbSrc = img.src;
      img.src = card;
    }
    return;
  }

  // Scoped to the button: a bare [data-reveal] once matched every post card
  // and swallowed every click in the feed.
  const revealBtn = target.closest('button[data-reveal]');
  if (revealBtn) {
    event.preventDefault();
    event.stopPropagation();
    const box = revealBtn.closest('.media');
    const img = box?.querySelector('img[data-sharp]');
    if (img) {
      img.dataset.loaded = 'false';
      img.src = img.dataset.sharp;
      img.alt = '';
    }
    box?.classList.remove('media--gated');
    revealBtn.remove();
    rememberReveal(Number(revealBtn.dataset.reveal));
    return;
  }

  const revealAllBtn = target.closest('[data-reveal-all]');
  if (revealAllBtn) {
    event.preventDefault();
    setRevealAll(revealAllBtn.dataset.revealAll === '1');
    route();
    return;
  }

  // Reaction picker → toggle. The server owns the counts, so the row is
  // repainted from its answer rather than guessed at optimistically.
  const reactBtn = target.closest('[data-react]');
  if (reactBtn) {
    event.preventDefault();
    event.stopPropagation();
    closeReactPicker();
    if (!state.me) return authModal('login');
    const bar = reactBtn.closest('[data-reactions]') || openPickerFor;
    const id = Number(bar?.dataset.reactions);
    if (!id) return;
    try {
      const { counts } = await api.post('/react', { type: 'post', id, emoji: reactBtn.dataset.react });
      repaintReactions(id, counts, reactBtn.dataset.react);
    } catch (err) {
      toast(err.message, 'error');
    }
    return;
  }

  const reactOpen = target.closest('[data-react-open]');
  if (reactOpen) {
    event.preventDefault();
    event.stopPropagation();
    if (!state.me) return authModal('login');
    toggleReactPicker(reactOpen);
    return;
  }
  closeReactPicker();

  const loadNew = target.closest('[data-load-new]');
  if (loadNew) {
    event.preventDefault();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    route();
    return;
  }

  const voteBtn = target.closest('[data-vote]');
  if (voteBtn) {
    event.preventDefault();
    event.stopPropagation();
    if (!state.me) return authModal('login');
    const group = voteBtn.closest('[data-vote-group]');
    const desired = Number(voteBtn.dataset.vote);
    const current = group.querySelector('[data-vote][data-active="up"]')
      ? 1
      : group.querySelector('[data-vote][data-active="down"]') ? -1 : 0;
    const value = current === desired ? 0 : desired;
    try {
      const result = await api.post(`/${group.dataset.type}s/${group.dataset.id}/vote`, { value });
      paintVote(group, { score: result.score ?? 0, value });
    } catch (err) {
      toast(err.message, 'error');
    }
    return;
  }

  const saveBtn = target.closest('[data-save]');
  if (saveBtn) {
    event.preventDefault();
    event.stopPropagation();
    if (!state.me) return authModal('login');
    try {
      const { saved } = await api.post(`/posts/${saveBtn.dataset.save}/save`);
      // Every copy of this post on screen should agree.
      view.querySelectorAll(`[data-save="${saveBtn.dataset.save}"]`).forEach((btn) => {
        btn.dataset.on = String(saved);
        btn.setAttribute('aria-pressed', String(saved));
        const label = btn.querySelector('.btn-label');
        if (label) label.textContent = saved ? 'Saved' : 'Save';
      });
      toast(saved ? 'Saved.' : 'Removed from saved.', 'ok');
    } catch (err) {
      toast(err.message, 'error');
    }
    return;
  }

  if (target.closest('#theme-toggle')) {
    setTheme(activeTheme() === 'dark' ? 'light' : 'dark');
    return;
  }

  const viewBtn = target.closest('[data-view]');
  if (viewBtn) {
    setView(viewBtn.dataset.view);
    return;
  }

  const link = target.closest('a[data-link]');
  if (link) {
    event.preventDefault();
    navigate(link.getAttribute('href'));
    return;
  }

  const authBtn = target.closest('[data-auth]');
  if (authBtn) return authModal(authBtn.dataset.auth);

  if (target.closest('[data-logout]')) {
    await api.post('/auth/logout');
    state.me = null;
    renderTopbarNav();
    renderLeftRail();
    toast('Signed out.');
    route();
    return;
  }

  if (target.closest('[data-reload]')) {
    location.reload();
    return;
  }

  const collapse = target.closest('[data-collapse]');
  if (collapse) {
    const comment = collapse.closest('.comment');
    comment.classList.toggle('is-collapsed');
    const toggle = comment.querySelector('.comment__toggle');
    const collapsed = comment.classList.contains('is-collapsed');
    toggle.hidden = !collapsed;
    toggle.textContent = collapsed ? `+ ${comment.querySelectorAll('.comment').length - 1} replies` : '−';
    return;
  }

  const replyBtn = target.closest('[data-reply]');
  if (replyBtn) {
    if (!state.me) return authModal('login');
    const slot = replyBtn.closest('.comment__row').querySelector('[data-reply-slot]');
    if (slot.firstChild) {
      slot.innerHTML = '';
      return;
    }
    slot.innerHTML = `
      <form class="composer" data-comment-form data-parent="${replyBtn.dataset.reply}" style="margin:8px 0 4px">
        <textarea class="textarea" name="body" rows="4" placeholder="Reply…" required></textarea>
        <div class="form-actions" style="margin-top:8px">
          <button class="btn btn--primary btn--sm" type="submit">Reply</button>
          <button class="btn btn--sm btn--ghost" type="button" data-cancel-reply>Cancel</button>
        </div>
      </form>`;
    slot.querySelector('textarea').focus();
    return;
  }

  if (target.closest('[data-cancel-reply]')) {
    target.closest('[data-reply-slot]').innerHTML = '';
    return;
  }

  const shareBtn = target.closest('[data-share]');
  if (shareBtn) {
    event.preventDefault();
    event.stopPropagation();
    const url = `${location.origin}/p/${shareBtn.dataset.share}`;
    try {
      if (navigator.share) await navigator.share({ url });
      else {
        await navigator.clipboard.writeText(url);
        toast('Link copied.', 'ok');
      }
    } catch {
      toast(url);
    }
    return;
  }

  const reportPost = target.closest('[data-report-post]');
  if (reportPost) {
    event.preventDefault();
    event.stopPropagation();
    return reportModal('post', reportPost.dataset.reportPost);
  }
  const reportComment = target.closest('[data-report-comment]');
  if (reportComment) return reportModal('comment', reportComment.dataset.reportComment);

  const subBtn = target.closest('[data-subscribe]');
  if (subBtn) {
    try {
      const { subscribed } = await api.post(`/boards/${subBtn.dataset.subscribe}/subscribe`);
      subBtn.innerHTML = `${subscribed ? icon('check', { size: 15 }) : icon('plus', { size: 15 })} ${subscribed ? 'Following' : 'Follow'}`;
      subBtn.classList.toggle('btn--primary', !subscribed);
      await loadBoards();
      renderLeftRail();
    } catch (err) {
      toast(err.message, 'error');
    }
    return;
  }

  const moreBtn = target.closest('[data-load-more]');
  if (moreBtn) return loadMore(moreBtn);

  const kindBtn = target.closest('[data-kind]');
  if (kindBtn) {
    const form = kindBtn.closest('form');
    form.querySelectorAll('[data-kind]').forEach((b) => b.setAttribute('aria-selected', String(b === kindBtn)));
    const isLink = kindBtn.dataset.kind === 'link';
    form.querySelector('[data-field="url"]').hidden = !isLink;
    form.querySelector('#submit-url').required = isLink;
    form.querySelector('#submit-body').required = !isLink;
    return;
  }

  const editPost = target.closest('[data-edit-post]');
  if (editPost) return startEditPost(editPost.dataset.editPost);

  const deletePost = target.closest('[data-delete-post]');
  if (deletePost) {
    if (!confirm('Delete this post? This cannot be undone.')) return;
    try {
      await api.del(`/posts/${deletePost.dataset.deletePost}`);
      toast('Post deleted.', 'ok');
      navigate('/');
    } catch (err) {
      toast(err.message, 'error');
    }
    return;
  }

  const editComment = target.closest('[data-edit-comment]');
  if (editComment) return startEditComment(editComment.dataset.editComment);

  const deleteComment = target.closest('[data-delete-comment]');
  if (deleteComment) {
    if (!confirm('Delete this comment?')) return;
    try {
      await api.del(`/comments/${deleteComment.dataset.deleteComment}`);
      const node = view.querySelector(`.comment[data-comment-id="${deleteComment.dataset.deleteComment}"]`);
      node?.classList.add('comment--removed');
      node?.querySelector('.comment__text')?.replaceChildren(
        Object.assign(document.createElement('em'), { textContent: 'Deleted.' })
      );
      toast('Comment deleted.', 'ok');
    } catch (err) {
      toast(err.message, 'error');
    }
    return;
  }

  const modAction = target.closest('[data-mod-action]');
  if (modAction) {
    const reason = prompt('Reason (logged):') ?? '';
    try {
      await api.post('/mod/action', {
        action: modAction.dataset.modAction,
        targetType: modAction.dataset.type,
        targetId: Number(modAction.dataset.id),
        reportId: modAction.dataset.reportId ? Number(modAction.dataset.reportId) : null,
        reason,
      });
      toast('Done.', 'ok');
      closeModal();
      route();
    } catch (err) {
      toast(err.message, 'error');
    }
    return;
  }

  const dismissBtn = target.closest('[data-dismiss]');
  if (dismissBtn) {
    try {
      await api.post('/mod/dismiss', { reportId: Number(dismissBtn.dataset.dismiss) });
      dismissBtn.closest('.report').remove();
      toast('Report dismissed.');
    } catch (err) {
      toast(err.message, 'error');
    }
    return;
  }

  const modPost = target.closest('[data-mod-post]');
  if (modPost) return modPostModal(modPost.dataset.modPost);

  const refreshBtn = target.closest('[data-refresh-wire]');
  if (refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'Pulling…';
    try {
      const summary = await api.post('/sources/run');
      const reached = summary.perSource.filter((s) => s.status === 'ok').length;
      const dead = summary.perSource.length - reached;
      toast(
        `Wire: +${summary.added} new from ${reached} source${reached === 1 ? '' : 's'}`
        + `${dead ? `, ${dead} unreachable` : ''}.`,
        dead && !summary.added ? 'error' : 'ok'
      );
      await Promise.all([loadTicker(), loadTrending(), loadTopics(), loadSources(), loadAds(), loadWireStatus()]);
  // After loadAds: the slot geometry has to exist before anything can mount.
  mountPersistentAds();
      renderRightRail();
      route();
    } catch (err) {
      toast(err.message, 'error');
      refreshBtn.disabled = false;
      refreshBtn.textContent = 'Pull the wire now';
    }
    return;
  }

  const profileTab = target.closest('[data-profile-tab]');
  if (profileTab) {
    const which = profileTab.dataset.profileTab;
    view.querySelectorAll('[data-profile-tab]').forEach((b) => b.setAttribute('aria-selected', String(b === profileTab)));
    view.querySelectorAll('[data-profile-panel]').forEach((p) => {
      p.hidden = p.dataset.profilePanel !== which;
    });
    return;
  }

  if (target.closest('#menu-toggle')) {
    document.body.classList.toggle('nav-open');
    return;
  }
  if (document.body.classList.contains('nav-open') && !target.closest('.rail--left')) {
    document.body.classList.remove('nav-open');
  }
});

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

document.addEventListener('submit', async (event) => {
  const form = event.target;

  if (form.id === 'search-form') {
    event.preventDefault();
    const q = qs('#search-input').value.trim();
    if (q.length >= 2) navigate(`/search?q=${encodeURIComponent(q)}`);
    return;
  }

  if (form.matches('[data-auth-form]')) {
    event.preventDefault();
    return submitAuth(form);
  }

  if (form.matches('[data-report-form]')) {
    event.preventDefault();
    const errorBox = form.querySelector('[data-error]');
    try {
      await api.post('/report', {
        targetType: form.dataset.type,
        targetId: Number(form.dataset.id),
        reason: form.reason.value,
        detail: form.detail.value,
      });
      closeModal();
      toast('Reported. A moderator will look at it.', 'ok');
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
    }
    return;
  }

  if (form.matches('[data-comment-form]')) {
    event.preventDefault();
    const button = form.querySelector('button[type=submit]');
    const body = form.body.value.trim();
    if (!body) return;
    button.disabled = true;

    try {
      const postId = state.currentPost.id;
      const parentId = form.dataset.parent ? Number(form.dataset.parent) : null;
      const { comment } = await api.post(`/posts/${postId}/comments`, { body, parentId });

      const holder = document.createElement('div');
      holder.innerHTML = commentTree([comment], state.currentPost.author);
      const node = holder.firstElementChild;

      if (parentId) {
        const parent = view.querySelector(`.comment[data-comment-id="${parentId}"]`);
        let children = parent.querySelector(':scope > .comment__children');
        if (!children) {
          children = document.createElement('div');
          children.className = 'comment__children';
          parent.append(children);
        }
        children.prepend(node);
        form.closest('[data-reply-slot]').innerHTML = '';
      } else {
        const root = view.querySelector('[data-comment-root]');
        root.querySelector('.empty')?.remove();
        root.prepend(node);
        form.body.value = '';
        button.disabled = false;
      }
      toast('Posted.', 'ok');
    } catch (err) {
      toast(err.message, 'error');
      button.disabled = false;
    }
    return;
  }

  if (form.matches('[data-submit-form]')) {
    event.preventDefault();
    const errorBox = form.querySelector('[data-error]');
    const button = form.querySelector('button[type=submit]');
    const kind = form.querySelector('[data-kind][aria-selected="true"]').dataset.kind;
    errorBox.hidden = true;
    button.disabled = true;

    try {
      const { id } = await api.post('/posts', {
        board: form.board.value,
        kind,
        title: form.title.value.trim(),
        body: form.body.value.trim(),
        url: kind === 'link' ? form.url.value.trim() : '',
        flair: form.flair.value.trim(),
      });
      toast('Thread posted.', 'ok');
      navigate(`/p/${id}`);
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
      button.disabled = false;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    return;
  }

  if (form.matches('[data-edit-form]')) {
    event.preventDefault();
    const kind = form.dataset.editKind;
    const id = form.dataset.editId;
    try {
      const { body } = await api.patch(`/${kind}s/${id}`, { body: form.body.value });
      if (kind === 'post') {
        view.querySelector('[data-post-body]').innerHTML = markdown(body);
      } else {
        const node = view.querySelector(`.comment[data-comment-id="${id}"]`);
        node.querySelector('.comment__text').innerHTML = markdown(body);
        node.dataset.raw = body;
      }
      closeModal();
      toast('Saved.', 'ok');
    } catch (err) {
      const errorBox = form.querySelector('[data-error]');
      errorBox.textContent = err.message;
      errorBox.hidden = false;
    }
  }
});

document.addEventListener('change', (event) => {
  const windowSelect = event.target.closest('[data-window]');
  if (windowSelect) {
    const url = new URL(location.href);
    url.searchParams.set('t', windowSelect.value);
    navigate(url.pathname + url.search);
    return;
  }

  const commentSort = event.target.closest('[data-comment-sort]');
  if (commentSort) {
    const url = new URL(location.href);
    url.searchParams.set('sort', commentSort.value);
    navigate(url.pathname + url.search);
  }
});

// ---------------------------------------------------------------------------
// Edit flows
// ---------------------------------------------------------------------------

function startEditPost(id) {
  const current = state.currentPost?.body || '';
  openModal(`
    <button class="icon-btn modal__close" data-close aria-label="Close">${icon('close', { size: 18 })}</button>
    <h2>Edit post</h2>
    <form data-edit-form data-edit-kind="post" data-edit-id="${id}">
      <div class="form-error" data-error hidden></div>
      <textarea class="textarea" name="body" rows="12">${esc(current)}</textarea>
      <div class="form-actions" style="margin-top:12px">
        <button class="btn btn--primary" type="submit">Save</button>
        <button class="btn btn--ghost" type="button" data-close>Cancel</button>
      </div>
    </form>`, { wide: true });
}

function startEditComment(id) {
  const node = view.querySelector(`.comment[data-comment-id="${id}"]`);
  const raw = node?.dataset.raw ?? '';
  openModal(`
    <button class="icon-btn modal__close" data-close aria-label="Close">${icon('close', { size: 18 })}</button>
    <h2>Edit comment</h2>
    <form data-edit-form data-edit-kind="comment" data-edit-id="${id}">
      <div class="form-error" data-error hidden></div>
      <textarea class="textarea" name="body" rows="8">${esc(raw)}</textarea>
      <div class="form-actions" style="margin-top:12px">
        <button class="btn btn--primary" type="submit">Save</button>
        <button class="btn btn--ghost" type="button" data-close>Cancel</button>
      </div>
    </form>`);
}

function modPostModal(id) {
  openModal(`
    <button class="icon-btn modal__close" data-close aria-label="Close">${icon('close', { size: 18 })}</button>
    <h2>Moderate post #${esc(id)}</h2>
    <p class="modal__sub">Every action is written to the public mod log.</p>
    <div class="form-actions" style="display:grid;gap:8px">
      <button class="btn btn--danger btn--block" data-mod-action="remove" data-type="post" data-id="${esc(id)}">Remove post</button>
      <button class="btn btn--block" data-mod-action="restore" data-type="post" data-id="${esc(id)}">Restore post</button>
      <button class="btn btn--block" data-mod-action="lock" data-type="post" data-id="${esc(id)}">Lock thread</button>
      <button class="btn btn--block" data-mod-action="unlock" data-type="post" data-id="${esc(id)}">Unlock thread</button>
      <button class="btn btn--block" data-mod-action="pin" data-type="post" data-id="${esc(id)}">Pin to board</button>
      <button class="btn btn--block" data-mod-action="unpin" data-type="post" data-id="${esc(id)}">Unpin</button>
    </div>`);
}

const isStaff = () => !!state.me && (state.me.role === 'mod' || state.me.role === 'admin');

// ---------------------------------------------------------------------------
// Background refresh
// ---------------------------------------------------------------------------

setInterval(async () => {
  if (document.hidden || !state.ageOk) return;
  await Promise.all([loadStats(), loadTrending()]);
  renderRightRail();
}, 60000);

setInterval(async () => {
  if (document.hidden || !state.ageOk) return;
  await loadTicker();
}, 300000);

// Images fade in once decoded. 'load' does not bubble, so this listens in the
// capture phase — and it keeps the handler out of the markup, which the CSP
// requires.
document.addEventListener(
  'load',
  (event) => {
    const img = event.target;
    if (img instanceof HTMLImageElement && img.closest('.media')) img.dataset.loaded = 'true';
  },
  true
);

window.addEventListener('popstate', route);

qs('#search-input').addEventListener(
  'input',
  debounce((e) => {
    const q = e.target.value.trim();
    if (q.length >= 2 && location.pathname === '/search') {
      navigate(`/search?q=${encodeURIComponent(q)}`, { replace: true });
    }
  }, 400)
);

boot();
