'use strict';

const crypto = require('crypto');
const { db } = require('./db');

const SESSION_COOKIE = 'ad_sid';
const AGE_COOKIE = 'ad_age';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const AGE_TTL_MS = 1000 * 60 * 60 * 24 * 90; // 90 days

const SECRET = process.env.SESSION_SECRET || 'dev-only-insecure-secret';
if (!process.env.SESSION_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('SESSION_SECRET must be set in production');
}

// ---------------------------------------------------------------------------
// Passwords — scrypt, which is memory-hard and ships with Node.
// ---------------------------------------------------------------------------

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, keyB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(keyB64, 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
    });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Sessions — random token in the cookie, only its SHA-256 lives in the DB, so a
// database leak does not hand out live sessions.
// ---------------------------------------------------------------------------

const insertSession = db.prepare(
  'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ua) VALUES (?, ?, ?, ?, ?)'
);
const selectSession = db.prepare(`
  SELECT s.user_id, s.expires_at,
         u.id, u.username, u.role, u.bio, u.avatar_seed, u.post_karma, u.comment_karma,
         u.created_at, u.banned_until, u.ban_reason, u.age_ok_at
    FROM sessions s JOIN users u ON u.id = s.user_id
   WHERE s.token_hash = ? AND s.expires_at > ?
`);
const deleteSession = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
const touchUser = db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?');

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

function createSession(userId, ua = '') {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  insertSession.run(sha256(token), userId, now, now + SESSION_TTL_MS, String(ua).slice(0, 200));
  return { token, expiresAt: now + SESSION_TTL_MS };
}

function destroySession(token) {
  if (token) deleteSession.run(sha256(token));
}

/**
 * Kill every session for a user except the one making the request.
 *
 * Called on password change, because that is what someone does when they think
 * another person has their old one — leaving those sessions alive would make
 * the change cosmetic.
 */
function dropOtherSessions(userId, keepToken) {
  return db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?')
    .run(userId, keepToken ? sha256(keepToken) : '').changes;
}

function setPassword(userId, hash) {
  return db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId).changes;
}

function readSession(token) {
  if (!token) return null;
  return selectSession.get(sha256(token), Date.now()) || null;
}

const cookieOpts = (maxAge) => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge,
  path: '/',
});

// ---------------------------------------------------------------------------
// Age gate — a signed cookie so the interstitial isn't trivially forged by
// hand. See README on why self-declaration alone is not compliant everywhere.
// ---------------------------------------------------------------------------

function signAgeToken(expiresAt) {
  const payload = String(expiresAt);
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyAgeToken(token) {
  if (!token || typeof token !== 'string') return false;
  const idx = token.lastIndexOf('.');
  if (idx < 1) return false;
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Number(payload) > Date.now();
}

/** Populates req.user (or null) and req.ageOk on every request. */
function attachUser(req, res, next) {
  const token = req.cookies?.[SESSION_COOKIE];
  const row = readSession(token);
  if (row) {
    const banned = row.banned_until > Date.now();
    req.user = {
      id: row.id,
      username: row.username,
      role: row.role,
      bio: row.bio,
      avatarSeed: row.avatar_seed,
      postKarma: row.post_karma,
      commentKarma: row.comment_karma,
      createdAt: row.created_at,
      banned,
      bannedUntil: row.banned_until,
      banReason: row.ban_reason,
    };
    // Cheap last-seen tracking: at most one write per user per 5 minutes.
    if (Date.now() - (row.last_seen_at || 0) > 300000) {
      try {
        touchUser.run(Date.now(), row.id);
      } catch {
        /* last_seen is best-effort */
      }
    }
  } else {
    req.user = null;
  }
  req.ageOk = verifyAgeToken(req.cookies?.[AGE_COOKIE]);
  next();
}

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in to do that.' });
  if (req.user.banned) {
    return res.status(403).json({
      error: `Your account is suspended until ${new Date(req.user.bannedUntil).toISOString()}.`,
      reason: req.user.banReason,
    });
  }
  next();
}

function requireStaff(req, res, next) {
  if (!req.user || (req.user.role !== 'mod' && req.user.role !== 'admin')) {
    return res.status(403).json({ error: 'Moderators only.' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admins only.' });
  }
  next();
}

module.exports = {
  SESSION_COOKIE,
  AGE_COOKIE,
  SESSION_TTL_MS,
  AGE_TTL_MS,
  hashPassword,
  verifyPassword,
  dropOtherSessions,
  createSession,
  destroySession,
  readSession,
  cookieOpts,
  signAgeToken,
  verifyAgeToken,
  attachUser,
  requireUser,
  requireStaff,
  requireAdmin,
};
