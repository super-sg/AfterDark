'use strict';

/**
 * robots.txt awareness for the wire crawler.
 *
 * We only ever fetch feed URLs a publisher advertises and article pages we were
 * linked to, but "we only fetch a few pages" is not a licence to ignore the file
 * the publisher wrote to tell crawlers what to do. Checking it costs one cached
 * request per host and is the difference between a well-behaved aggregator and
 * one that gets its IP blocked.
 *
 * Deliberately small: group selection by user-agent, Allow/Disallow with the
 * longest-match-wins rule from the original spec, and Crawl-delay. Wildcards
 * (`*`) and end-anchors (`$`) are supported because real files use them.
 */

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // publishers change this rarely
const FETCH_TIMEOUT_MS = 8000;
const MAX_ROBOTS_BYTES = 512 * 1024;

const cache = new Map(); // origin -> { rules, crawlDelay, expires }

/**
 * Turn a robots path pattern into an anchored regexp.
 *
 * The trailing `$` has to be recognised before escaping, not after: escaping
 * turns it into `\$`, at which point it is a literal dollar sign and the
 * end-anchor is silently lost — so `Disallow: /*.pdf$` would match nothing.
 */
function toPattern(raw) {
  const text = String(raw);
  const endAnchored = text.endsWith('$');
  const body = endAnchored ? text.slice(0, -1) : text;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}${endAnchored ? '$' : ''}`);
}

/**
 * Parse a robots.txt body into the rule list that applies to `agent`.
 *
 * Groups are keyed by user-agent. A specific match beats `*`; if several
 * consecutive User-agent lines share one block, all of them get the rules.
 */
function parse(body, agent = '*') {
  const lines = String(body).split(/\r?\n/);
  const groups = new Map(); // ua -> { rules: [], crawlDelay: 0 }
  let current = [];
  let expectingAgents = false;

  const groupFor = (ua) => {
    if (!groups.has(ua)) groups.set(ua, { rules: [], crawlDelay: 0 });
    return groups.get(ua);
  };

  for (const line of lines) {
    const text = line.replace(/#.*$/, '').trim();
    if (!text) continue;
    const idx = text.indexOf(':');
    if (idx === -1) continue;
    const field = text.slice(0, idx).trim().toLowerCase();
    const value = text.slice(idx + 1).trim();

    if (field === 'user-agent') {
      // A User-agent line right after another starts a shared group; one after
      // a rule starts a fresh group.
      if (!expectingAgents) current = [];
      current.push(value.toLowerCase());
      expectingAgents = true;
      groupFor(value.toLowerCase());
      continue;
    }

    expectingAgents = false;
    if (!current.length) continue;

    if (field === 'disallow' || field === 'allow') {
      // "Disallow:" with an empty value means allow everything — not a rule.
      if (field === 'disallow' && value === '') continue;
      for (const ua of current) {
        groupFor(ua).rules.push({ allow: field === 'allow', path: value, re: toPattern(value) });
      }
    } else if (field === 'crawl-delay') {
      const secs = Number.parseFloat(value);
      if (Number.isFinite(secs) && secs >= 0) {
        for (const ua of current) groupFor(ua).crawlDelay = Math.min(secs, 60);
      }
    }
  }

  const lower = agent.toLowerCase();
  // Longest matching user-agent token wins, then the catch-all.
  let best = null;
  for (const [ua, group] of groups) {
    if (ua === '*') continue;
    if (lower.includes(ua) && (!best || ua.length > best.ua.length)) best = { ua, group };
  }
  const chosen = best ? best.group : groups.get('*') || { rules: [], crawlDelay: 0 };
  return { rules: chosen.rules, crawlDelay: chosen.crawlDelay };
}

/**
 * Longest-match-wins. Where an Allow and a Disallow match the same length,
 * Allow wins — that is what Google and the RFC 9309 draft both specify.
 */
function isAllowed(rules, pathname) {
  let winner = null;
  for (const rule of rules) {
    if (!rule.re.test(pathname)) continue;
    if (!winner || rule.path.length > winner.path.length
        || (rule.path.length === winner.path.length && rule.allow)) {
      winner = rule;
    }
  }
  return winner ? winner.allow : true;
}

async function load(origin, agent) {
  const hit = cache.get(origin);
  if (hit && hit.expires > Date.now()) return hit;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let parsed = { rules: [], crawlDelay: 0 };
  try {
    const res = await fetch(`${origin}/robots.txt`, {
      signal: controller.signal,
      headers: { 'user-agent': agent, accept: 'text/plain,*/*' },
      redirect: 'follow',
    });
    if (res.status >= 200 && res.status < 300) {
      const body = (await res.text()).slice(0, MAX_ROBOTS_BYTES);
      parsed = parse(body, agent);
    }
    // 404 or 410 means "no restrictions". A 5xx technically means "stay away",
    // but treating a publisher's bad day as a permanent ban would silently kill
    // a source, so we allow and re-check on the next TTL.
  } catch {
    // Unreachable robots.txt — same reasoning as 5xx.
  } finally {
    clearTimeout(timer);
  }

  const entry = { ...parsed, expires: Date.now() + DEFAULT_TTL_MS };
  cache.set(origin, entry);
  return entry;
}

/**
 * May we fetch this URL?
 * @returns {Promise<{allowed:boolean, crawlDelay:number}>}
 */
async function check(rawUrl, agent) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, crawlDelay: 0 };
  }
  const { rules, crawlDelay } = await load(url.origin, agent);
  return { allowed: isAllowed(rules, url.pathname + url.search), crawlDelay };
}

function clearCache() {
  cache.clear();
}

module.exports = { check, parse, isAllowed, clearCache };
