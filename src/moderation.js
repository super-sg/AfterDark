'use strict';

/**
 * Content safety.
 *
 * Two tiers:
 *   HARD_BLOCK — content that is illegal or that no amount of moderation makes
 *                acceptable. Submission is rejected outright and logged.
 *   SOFT_FLAG  — content that gets queued for a human moderator but still posts.
 *
 * This is a floor, not a moderation strategy. Any real deployment needs human
 * moderators and, for anything image-bearing, a hash-matching service
 * (PhotoDNA / Cloudflare CSAM Scanning Tool / Thorn Safer).
 */

/**
 * Supply and solicitation context — the words that turn *discussing* a category
 * into *trafficking in* it. This distinction is the whole design of this layer:
 * a site whose subject matter is the adult industry must be able to publish
 * reporting on NCII law, trafficking legislation and CSAM enforcement. Blocking
 * the vocabulary would block the journalism.
 *
 * Deliberately excluded: "share", "sharing", "download", "request", "buy",
 * "collection", "archive". Every one of them is load-bearing in policy writing
 * ("prevent the non-consensual sharing of intimate images") and none is a
 * reliable signal of solicitation on its own. What remains is language that
 * essentially only appears when someone is sourcing or offering material.
 */
const SUPPLY = String.raw`(?:links?|linked|trad(?:e|ing)|swap|dumps?|folder|mega|gdrive|g-?drive|torrent|magnet|onion|sauce|source\?|where\s+(?:can|do)\s+i|anyone\s+(?:got|have)|looking\s+for|dm\s+me|pm\s+me|hmu|selling|for\s+sale|drop\s+(?:it|the)|send\s+(?:me|it))`;

/**
 * Sexual nouns, kept narrow so "child safety content" is not swept up. Note
 * what is deliberately absent: "child sexual abuse material" and "CSAM" are the
 * technical and legal terms of art, used constantly in enforcement reporting.
 * They are handled below, and only when paired with supply context.
 */
const SEXUAL = String.raw`(?:porn|pornography|nudes?|naked|xxx|nsfw|sexual\s+(?:content|images?|material)|sex\s+(?:tape|video|pics?))`;

const near = (a, b, gap = 40) => new RegExp(String.raw`\b${a}\b[\s\S]{0,${gap}}\b${b}\b`, 'i');

/**
 * Statutory and technical terms of art.
 *
 * "Material harmful to minors" is the operative phrase in every US age
 * verification statute. "Child sexual abuse material" is what the enforcement
 * literature calls the thing. "Non-consensual intimate images" is the language
 * of the TAKE IT DOWN Act. A site reporting on this beat writes these phrases
 * constantly, and a proximity filter reads every one of them as a violation.
 *
 * These are masked out before the PROXIMITY rules run — but *not* before the
 * SUPPLY rules, so "child sexual abuse material, links below" is still caught.
 */
const TERMS_OF_ART = [
  /\b(?:sexual\s+)?material\s+harmful\s+to\s+minors\b/gi,
  /\bharmful\s+to\s+minors\b/gi,
  /\bchild\s+sexual\s+abuse\s+(?:material|imagery|images)\b/gi,
  /\bchild\s+(?:safety|protection|exploitation|abuse)\b/gi,
  /\bprotection\s+of\s+minors\b/gi,
  /\bminor[- ]protection\b/gi,
  /\bnon-?consensual\s+intimate\s+(?:images?|imagery|visual\s+depictions?)\b/gi,
  /\bintimate\s+image\s+abuse\b/gi,
  /\bage[- ]verification\b/gi,
  /\bage\s+assurance\b/gi,
];

const maskTermsOfArt = (text) =>
  TERMS_OF_ART.reduce((acc, re) => acc.replace(re, ' [term-of-art] '), text);

/**
 * Supply vocabulary in a prevention frame.
 *
 * "Prevent the sharing of intimate images" and "anyone got a folder of intimate
 * images" contain the same supply word. What separates them is the verb in
 * front of it. Enforcement writing is built out of exactly these constructions,
 * so a supply word governed by one of them is neutralised before matching.
 */
const PREVENTION_FRAME = new RegExp(
  String.raw`\b(?:prevent\w*|prohibit\w*|criminali[sz]\w*|ban(?:s|ned|ning)?|outlaw\w*|combat\w*|stop\w*|block\w*|detect\w*|remov\w*|takedown|take-?down|against|illegal|unlawful|penalt\w*|liab\w*|convict\w*|prosecut\w*)\b[\s\S]{0,24}?\b${SUPPLY}\b`,
  'gi'
);

const maskPrevention = (text) => text.replace(PREVENTION_FRAME, ' [prevention] ');

/**
 * Rejected on proximity alone. Sexual content involving minors is the one
 * category where the cost asymmetry justifies false positives — but only after
 * the terms of art above have been masked out.
 */
const HARD_BLOCK_PROXIMITY = [
  /\b(?:c+[\W_]*p+|cheese\s*pizza)\b(?=[\s\S]{0,40}(?:link|trade|dump|folder|mega|drive))/i,
  near(String.raw`(?:child|kids?|minors?|preteens?|pre-teens?|underage|under\s*age|jailbait|loli(?:c?on)?|shota(?:c?on)?)`, SEXUAL, 30),
  near(SEXUAL, String.raw`(?:child|kids?|minors?|preteens?|underage|jailbait)`, 30),
  /\b(?:1[0-7]|[3-9])\s*(?:yo|y\/o|yrs?\s*old|years?\s*old)\b[\s\S]{0,40}\b(?:nude|naked|porn|sex|xxx|sexy)\b/i,
];

/**
 * Rejected only alongside supply or solicitation context, and checked against
 * the unmasked text. Reporting and debate pass; sourcing does not.
 */
const NCII = String.raw`(?:revenge\s*porn|leaked\s*nudes?|non-?consensual\s+(?:intimate\s+)?(?:porn|images?|imagery|material|content|videos?|clips?|visual\s+depictions?)|intimate\s+image\s+abuse|ncii)`;
const CSAM = String.raw`(?:csam|child\s+sexual\s+abuse\s+(?:material|imagery|images))`;
const SYNTHETIC = String.raw`(?:deep\s*fakes?|deepfakes?|face\s*swaps?|ai\s+nudes?|nudif(?:y|ier|ication))`;
const VOYEUR = String.raw`(?:rape|drugged|unconscious|hidden\s*cam(?:era)?|spy\s*cam|upskirt|creep\s*shots?|voyeur)`;
const TRAFFICKING = String.raw`(?:sex\s*traffick\w*|trafficked\s+(?:girls?|women|minors?))`;

const HARD_BLOCK_SUPPLY = [CSAM, NCII, SYNTHETIC, VOYEUR, TRAFFICKING].flatMap((term) => [
  near(term, SUPPLY, 60),
  near(SUPPLY, term, 60),
]);

// Doxxing / spam / off-platform solicitation. Flagged, not blocked.
const SOFT_FLAG = [
  /\b(?:\+?\d[\d\s().-]{8,}\d)\b/, // phone numbers
  /\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/, // email addresses
  /\b(?:t\.me|telegram|whatsapp|snap(?:chat)?|kik|wickr|discord\.gg)\b/i,
  /\b(?:bitcoin|btc|usdt|crypto)\b[\s\S]{0,30}\b(?:send|pay|wallet|address)\b/i,
  /\b(?:free\s+(?:premium|account|gift\s*card)|click\s+here\s+now|100%\s+free)\b/i,
  /\b(?:my\s+(?:onlyfans|fansly|linktree)|dm\s+me\s+for)\b/i,
];

const HARD_BLOCK_MESSAGE =
  'This content is blocked. AfterDark permanently prohibits any sexual content or ' +
  'discussion involving minors, and any non-consensual material. This attempt has been logged.';

function normalise(text) {
  return String(text || '')
    .normalize('NFKD')
    // Collapse leetspeak and separator obfuscation so filters can't be dodged
    // with "m1n0r" or "u_n_d_e_r_a_g_e".
    .replace(/[0]/g, 'o')
    .replace(/[1!|]/g, 'i')
    .replace(/[3]/g, 'e')
    .replace(/[4@]/g, 'a')
    .replace(/[5$]/g, 's')
    .replace(/[7]/g, 't')
    .replace(/[^\p{L}\p{N}\s@.+/:-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * @returns {{ ok: boolean, reason?: string, flags: string[] }}
 */
function screen(...parts) {
  const raw = parts.filter(Boolean).join('\n');
  const text = normalise(raw);
  // Both the original and a de-obfuscated copy, so "m1n0r" is caught without
  // the normaliser's digit substitutions mangling legitimate text.
  const probe = `${raw}\n${text}`;

  for (const re of HARD_BLOCK_PROXIMITY) {
    if (re.test(maskTermsOfArt(probe))) {
      return { ok: false, reason: HARD_BLOCK_MESSAGE, flags: ['hard_block', 'proximity'] };
    }
  }

  const supplyProbe = maskPrevention(probe);
  for (const re of HARD_BLOCK_SUPPLY) {
    if (re.test(supplyProbe)) {
      return { ok: false, reason: HARD_BLOCK_MESSAGE, flags: ['hard_block', 'supply'] };
    }
  }

  const flags = [];
  for (const re of SOFT_FLAG) {
    if (re.test(raw)) flags.push(re.source.slice(0, 40));
  }
  if (raw.length > 40) {
    const letters = raw.replace(/[^a-z]/gi, '');
    const caps = raw.replace(/[^A-Z]/g, '');
    if (letters.length && caps.length / letters.length > 0.6) flags.push('shouting');
  }
  const linkCount = (raw.match(/https?:\/\//g) || []).length;
  if (linkCount > 4) flags.push('link_spam');

  return { ok: true, flags };
}

/** Strip control characters and normalise whitespace before storage. */
function clean(text, maxLen) {
  let out = String(text ?? '')
    // Control characters, plus zero-width and bidi-override characters used
    // to smuggle text past filters and to spoof usernames.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  if (maxLen && out.length > maxLen) out = out.slice(0, maxLen);
  return out;
}

const URL_OK = /^https?:\/\/[^\s<>"']+$/i;

function cleanUrl(url) {
  const u = clean(url, 2000);
  if (!u) return '';
  if (!URL_OK.test(u)) return null;
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-action rate limiting. In-memory, per worker — deliberately simple. Swap
// the store for Redis if you run more than one machine.
// ---------------------------------------------------------------------------

const buckets = new Map();

/**
 * Token bucket. Returns true when the action is allowed.
 * @param {string} key   e.g. `post:42`
 * @param {number} limit actions allowed per window
 * @param {number} windowMs
 */
function allow(key, limit, windowMs) {
  const now = Date.now();
  const entry = buckets.get(key);
  if (!entry || now > entry.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count += 1;
  return true;
}

function retryAfter(key) {
  const entry = buckets.get(key);
  return entry ? Math.max(1, Math.ceil((entry.resetAt - Date.now()) / 1000)) : 1;
}

// Keep the map from growing without bound on a long-lived process.
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of buckets) if (now > entry.resetAt) buckets.delete(key);
}, 60000);
sweep.unref();

const LIMITS = {
  post: { limit: 5, windowMs: 10 * 60 * 1000 },
  comment: { limit: 20, windowMs: 5 * 60 * 1000 },
  vote: { limit: 200, windowMs: 60 * 1000 },
  report: { limit: 10, windowMs: 10 * 60 * 1000 },
  register: { limit: 5, windowMs: 60 * 60 * 1000 },
  login: { limit: 10, windowMs: 15 * 60 * 1000 },
};

module.exports = { screen, clean, cleanUrl, allow, retryAfter, LIMITS, HARD_BLOCK_MESSAGE };
