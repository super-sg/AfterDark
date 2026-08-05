// Flat line-icon set. 24×24 grid, 1.75 stroke, round caps and joins — one
// consistent geometry so nothing looks borrowed. Rendered inline rather than
// from a sprite file so icons never flash in after paint.
//
// Voting arrows are the exception: they are filled, because a hairline stroke
// does not read as "pressed" at 14px, and vote state has to be unmistakable.

const STROKE = {
  // navigation & chrome
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M4 12.5l5 5L20 6.5"/>',
  chevronDown: '<path d="M6 9.5l6 6 6-6"/>',
  chevronRight: '<path d="M9.5 6l6 6-6 6"/>',
  arrowLeft: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  externalLink: '<path d="M14 5h5v5"/><path d="M19 5l-8 8"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
  moreHorizontal: '<circle cx="5.5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18.5" cy="12" r="1.4"/>',

  // actions
  comment: '<path d="M20 11.5a7.5 7.5 0 0 1-10.9 6.7L4 19.5l1.4-4.6A7.5 7.5 0 1 1 20 11.5Z"/>',
  share: '<path d="M4 12v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6"/><path d="M12 15V4"/><path d="M8 8l4-4 4 4"/>',
  bookmark: '<path d="M18 20l-6-4.2L6 20V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v14Z"/>',
  flag: '<path d="M5 20V4"/><path d="M5 5h11l-2 3.5L16 12H5"/>',
  link: '<path d="M10.5 13.5a3.5 3.5 0 0 0 5 0l3-3a3.54 3.54 0 0 0-5-5l-1.4 1.4"/><path d="M13.5 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.54 3.54 0 0 0 5 5l1.4-1.4"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  bell: '<path d="M18 9a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16S18 14 18 9Z"/><path d="M13.7 19a2 2 0 0 1-3.4 0"/>',
  edit: '<path d="M12 20h8"/><path d="M16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1 1-4Z"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6.5 7l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12"/>',

  // identity
  user: '<circle cx="12" cy="8.5" r="3.75"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
  logOut: '<path d="M15 5.5H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9"/><path d="M14 12h7"/><path d="M18 8.5l3.5 3.5L18 15.5"/>',
  shield: '<path d="M12 3.5 5 6.2v5.3c0 4.2 2.8 7.6 7 9 4.2-1.4 7-4.8 7-9V6.2Z"/>',
  shieldCheck: '<path d="M12 3.5 5 6.2v5.3c0 4.2 2.8 7.6 7 9 4.2-1.4 7-4.8 7-9V6.2Z"/><path d="M9 12l2.2 2.2L15.5 10"/>',

  // feeds & sorts
  home: '<path d="M4 10.5 12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19Z"/>',
  flame: '<path d="M12 3.5s5.5 4 5.5 8.5a5.5 5.5 0 0 1-11 0c0-1.6.8-3 1.6-4 .2 1.2.9 2 1.9 2 1.4 0 2-1.6 2-3.2 0-1.3 0-2.6 0-3.3Z"/>',
  sparkle: '<path d="M12 3.5 13.6 9 19 10.6 13.6 12.2 12 17.7 10.4 12.2 5 10.6 10.4 9Z"/><path d="M18.5 16.5l.6 1.9 1.9.6-1.9.6-.6 1.9-.6-1.9-1.9-.6 1.9-.6Z"/>',
  trendingUp: '<path d="M3.5 16.5 9 11l3.5 3.5L20.5 6.5"/><path d="M15.5 6.5h5v5"/>',
  star: '<path d="m12 4 2.5 5 5.5.8-4 3.9.95 5.5L12 16.6 7.05 19.2 8 13.7 4 9.8 9.5 9Z"/>',
  layers: '<path d="m12 3.5 8.5 4.3L12 12 3.5 7.8Z"/><path d="m3.5 12.2 8.5 4.3 8.5-4.3"/><path d="m3.5 16.4 8.5 4.3 8.5-4.3"/>',

  // board glyphs
  newspaper: '<path d="M4 6.5A1.5 1.5 0 0 1 5.5 5h10A1.5 1.5 0 0 1 17 6.5V19H5.5A1.5 1.5 0 0 1 4 17.5Z"/><path d="M17 9h1.5A1.5 1.5 0 0 1 20 10.5v7A1.5 1.5 0 0 1 18.5 19H17"/><path d="M7 9h7M7 12.5h7M7 16h4"/>',
  scale: '<path d="M12 4v16"/><path d="M7 20h10"/><path d="M4 8h16"/><path d="M4 8 1.8 13.5a2.6 2.6 0 0 0 4.4 0Z"/><path d="M20 8l-2.2 5.5a2.6 2.6 0 0 0 4.4 0Z"/>',
  chart: '<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M3 20h18"/>',
  messages: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5v5A1.5 1.5 0 0 1 14.5 12H8l-4 3Z"/><path d="M8 15v.5A1.5 1.5 0 0 0 9.5 17H16l4 3v-8.5A1.5 1.5 0 0 0 18.5 10H16"/>',
  film: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M8 5v14M16 5v14M3.5 12h17M3.5 8.5h4.5M3.5 15.5h4.5M16 8.5h4.5M16 15.5h4.5"/>',
  video: '<rect x="3" y="6.5" width="12" height="11" rx="2"/><path d="m15 11 5.5-3v8L15 13Z"/>',
  wrench: '<path d="M15.5 3.8a5 5 0 0 0-5.9 6.6L4 16l4 4 5.6-5.6a5 5 0 0 0 6.6-5.9l-3 3-2.7-2.7Z"/>',
  compass: '<circle cx="12" cy="12" r="8.5"/><path d="m15.5 8.5-2 5.5-5.5 2 2-5.5Z"/>',
  users: '<circle cx="9.5" cy="8.5" r="3.25"/><path d="M3.5 19a6 6 0 0 1 12 0"/><path d="M16 5.6a3.25 3.25 0 0 1 0 6.3"/><path d="M17.5 14.2A6 6 0 0 1 20.5 19"/>',

  // media
  play: '<circle cx="12" cy="12" r="8.5"/><path d="M10.2 8.8 15.5 12l-5.3 3.2Z"/>',
  eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 6.1A9.6 9.6 0 0 1 12 6c6 0 9.5 6 9.5 6a17 17 0 0 1-3.3 4"/><path d="M6.5 8.2A16.6 16.6 0 0 0 2.5 12S6 18 12 18a9.4 9.4 0 0 0 3.6-.7"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  smile: '<circle cx="12" cy="12" r="8.5"/><path d="M8.8 14.2a4 4 0 0 0 6.4 0"/><path d="M9.3 9.6h.01M14.7 9.6h.01"/>',
  radio: '<circle cx="12" cy="12" r="2.5"/><path d="M8.1 8.1a5.5 5.5 0 0 0 0 7.8M15.9 15.9a5.5 5.5 0 0 0 0-7.8"/><path d="M5.3 5.3a9.5 9.5 0 0 0 0 13.4M18.7 18.7a9.5 9.5 0 0 0 0-13.4"/>',
  hash: '<path d="M9 4 7 20M17 4l-2 16M4.5 9h15M3.5 15h15"/>',
  pen: '<path d="M4 20h4l10.5-10.5a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5Z"/><path d="M13.5 7.5 16.5 10.5"/>',
  arrowUp: '<path d="M12 20V5"/><path d="M6 11l6-6 6 6"/>',
  image: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="8.75" cy="9.75" r="1.5"/><path d="m4 16.5 4.2-3.6a1.6 1.6 0 0 1 2.1 0L15 17"/><path d="m13.5 14 1.7-1.5a1.6 1.6 0 0 1 2.1 0L20.5 15"/>',

  // view modes
  viewCard: '<rect x="4" y="4" width="16" height="7" rx="1.5"/><rect x="4" y="13" width="16" height="7" rx="1.5"/>',
  viewCompact: '<path d="M4 7h16M4 12h16M4 17h16" /><path d="M4 7h3M4 12h3M4 17h3" stroke-width="3"/>',
  viewClassic: '<rect x="4" y="5" width="5" height="5" rx="1"/><rect x="4" y="14" width="5" height="5" rx="1"/><path d="M12 6.5h8M12 9h5M12 15.5h8M12 18h5"/>',
};

// Filled, because vote state must be legible at 14px.
const FILLED = {
  voteUp: '<path d="M12 4.2 21 14h-5.4v5.8H8.4V14H3Z"/>',
  voteDown: '<path d="M12 19.8 3 10h5.4V4.2h7.2V10H21Z"/>',
};

/**
 * @param {keyof STROKE | keyof FILLED} name
 * @param {{size?: number, className?: string, strokeWidth?: number}} opts
 */
export function icon(name, { size = 20, className = '', strokeWidth = 1.75 } = {}) {
  const filled = FILLED[name];
  const body = filled || STROKE[name];
  if (!body) return '';
  const paint = filled
    ? 'fill="currentColor" stroke="none"'
    : `fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"`;
  return `<svg class="ico${className ? ` ${className}` : ''}" viewBox="0 0 24 24" width="${size}" height="${size}" ${paint} aria-hidden="true" focusable="false">${body}</svg>`;
}

/** Board slug → glyph. Keeps board identity consistent everywhere it appears. */
export const BOARD_ICONS = {
  newsroom: 'newspaper',
  business: 'chart',
  policy: 'scale',
  discussion: 'messages',
  industry: 'film',
  creators: 'video',
  ethics: 'shieldCheck',
  tech: 'wrench',
  meta: 'compass',
  videos: 'play',
  jav: 'film',
  hentai: 'sparkle',
};

export const boardIcon = (slug, opts) => icon(BOARD_ICONS[slug] || 'messages', opts);

export const ICON_NAMES = [...Object.keys(STROKE), ...Object.keys(FILLED)];
