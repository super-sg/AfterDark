// Small helpers shared across views. No dependencies, no build step.

/** Escape before anything user-authored reaches innerHTML. */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function attr(value) {
  return esc(value).replace(/`/g, '&#96;');
}

const UNITS = [
  [31536000, 'y'],
  [2592000, 'mo'],
  [604800, 'w'],
  [86400, 'd'],
  [3600, 'h'],
  [60, 'm'],
];

export function timeAgo(ms) {
  const seconds = Math.max(1, Math.floor((Date.now() - Number(ms)) / 1000));
  for (const [size, label] of UNITS) {
    if (seconds >= size) return `${Math.floor(seconds / size)}${label} ago`;
  }
  return `${seconds}s ago`;
}

export function fullDate(ms) {
  return new Date(Number(ms)).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function num(value) {
  const n = Number(value) || 0;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}m`;
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

/** Deterministic avatar gradient from a username so identity is visually stable. */
export function avatarStyle(seed) {
  let hash = 0;
  const key = String(seed || '?');
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  return `--av-a:hsl(${hue} 62% 62%); --av-b:hsl(${(hue + 48) % 360} 58% 44%)`;
}

export function initials(name) {
  const clean = String(name || '?').replace(/[^a-z0-9]/gi, '');
  return (clean.slice(0, 2) || '?').toUpperCase();
}

/**
 * Minimal, safe Markdown. Input is escaped first, so the only HTML that can
 * reach the page is the tags produced here.
 */
export function markdown(source) {
  const text = esc(source || '').trim();
  if (!text) return '';

  const blocks = text.split(/\n{2,}/);
  const out = [];

  for (const raw of blocks) {
    const block = raw.trim();
    if (!block) continue;

    if (/^#{1,3}\s/.test(block)) {
      out.push(`<h3>${inline(block.replace(/^#{1,3}\s+/, ''))}</h3>`);
      continue;
    }

    if (block.split('\n').every((l) => /^&gt;\s?/.test(l))) {
      const body = block.split('\n').map((l) => l.replace(/^&gt;\s?/, '')).join(' ');
      out.push(`<blockquote>${inline(body)}</blockquote>`);
      continue;
    }

    if (block.split('\n').every((l) => /^\s*[-*]\s+/.test(l))) {
      const items = block.split('\n').map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`);
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    if (block.split('\n').every((l) => /^\s*\d+[.)]\s+/.test(l))) {
      const items = block.split('\n').map((l) => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ''))}</li>`);
      out.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    out.push(`<p>${inline(block).replace(/\n/g, '<br />')}</p>`);
  }

  return out.join('');
}

function inline(text) {
  return text
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>')
    // Autolink. The URL has already been HTML-escaped, and rel/target keep the
    // destination from touching this document.
    .replace(
      /\bhttps?:\/\/[^\s<>"']+/g,
      (url) => `<a href="${url}" rel="noopener nofollow ugc" target="_blank">${shortUrl(url)}</a>`
    );
}

function shortUrl(url) {
  return url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '').slice(0, 60);
}

/** Strip Markdown syntax for previews, where only the words matter. */
export function plainText(source) {
  return String(source || '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*&gt;\s?/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/\s*\n+\s*/g, ' ')
    .trim();
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Tagged template that escapes every interpolated value. */
export function html(strings, ...values) {
  return strings.reduce((acc, part, i) => acc + part + (i < values.length ? esc(values[i]) : ''), '');
}

export function debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export function qs(sel, root = document) {
  return root.querySelector(sel);
}

export function qsa(sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}
