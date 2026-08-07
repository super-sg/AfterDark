'use strict';

/**
 * "Buy me a coffee" — reader support.
 *
 * The site is ad-supported, and ad-supported adult inventory pays badly: the
 * networks that will take the traffic at all are the ones paying the least for
 * it. Reader support is the only revenue here that does not require putting
 * another banner in front of somebody.
 *
 * Two modes, because the payment processor is not wired up yet and the page
 * should not have to wait for it:
 *
 *   link     A plain URL — a Razorpay Payment Page, a Buy Me a Coffee profile,
 *            a UPI link, anything. Renders as an anchor. No third-party script,
 *            so the site's `script-src 'self'` is untouched. This is the mode
 *            that works today with one environment variable.
 *
 *   razorpay Full Checkout. The server creates the order (so the amount is
 *            decided here and cannot be edited in the browser) and verifies the
 *            signature on the way back. Switches on by itself the moment
 *            RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are both set — there is no
 *            third variable to remember, because a half-configured payment flow
 *            that looks live is worse than one that is plainly off.
 *
 * With neither configured the support page still renders and says so, rather
 * than 404ing. A dead link in the footer is a bug report; an honest "not open
 * yet" is a roadmap.
 */

const crypto = require('node:crypto');
const { db } = require('./db');

const ENABLED = process.env.SUPPORT_ENABLED !== '0';

const RZP_KEY_ID = String(process.env.RAZORPAY_KEY_ID || '').trim();
const RZP_KEY_SECRET = String(process.env.RAZORPAY_KEY_SECRET || '').trim();
const RZP_READY = !!(RZP_KEY_ID && RZP_KEY_SECRET);

/** A payment link. Used on its own, and as the fallback if Checkout errors. */
const SUPPORT_URL = String(process.env.SUPPORT_URL || '').trim();

const CURRENCY = String(process.env.SUPPORT_CURRENCY || 'INR').trim().toUpperCase();

/**
 * Amounts are held in the currency's minor unit (paise for INR) because that
 * is what Razorpay's API takes and what every rounding bug in payment code
 * comes from converting between. They are only turned into a display string at
 * the edge.
 */
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK']);
const minorPerMajor = (currency) => (ZERO_DECIMAL.has(currency) ? 1 : 100);

const SYMBOLS = { INR: '₹', USD: '$', EUR: '€', GBP: '£', BDT: '৳' };

/**
 * The tiers. Overridable as a comma-separated list of major-unit amounts, so
 * an operator can re-price for their currency without a deploy:
 *   SUPPORT_TIERS=100,500,1000
 */
const DEFAULT_TIERS = [99, 299, 599];

function tierAmounts() {
  const raw = String(process.env.SUPPORT_TIERS || '').trim();
  if (!raw) return DEFAULT_TIERS;
  const parsed = raw
    .split(',')
    .map((n) => Number(n.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return parsed.length ? parsed : DEFAULT_TIERS;
}

/**
 * Labels are per-position rather than per-amount, so re-pricing does not
 * silently turn "a coffee" into something that no longer buys one.
 */
const LABELS = [
  { label: 'A coffee', blurb: 'Keeps the wire pulling for a day.' },
  { label: 'A round', blurb: 'Covers a week of the server the site runs on.' },
  { label: 'A month', blurb: 'Pays for the whole box, hosting and bandwidth.' },
  { label: 'Patron', blurb: 'Funds reporting rather than just keeping it up.' },
];

const format = (major) => {
  const symbol = SYMBOLS[CURRENCY] || `${CURRENCY} `;
  return `${symbol}${major.toLocaleString('en-IN')}`;
};

function tiers() {
  return tierAmounts().map((major, i) => ({
    id: `t${i + 1}`,
    amount: major * minorPerMajor(CURRENCY),
    major,
    display: format(major),
    ...(LABELS[i] || { label: format(major), blurb: 'Thank you.' }),
  }));
}

/** The mode the client should render. */
function mode() {
  if (!ENABLED) return 'off';
  if (RZP_READY) return 'razorpay';
  if (SUPPORT_URL) return 'link';
  return 'unconfigured';
}

function config() {
  return {
    enabled: ENABLED,
    mode: mode(),
    currency: CURRENCY,
    tiers: tiers(),
    // Present in link mode; also handed over in razorpay mode as the escape
    // hatch when Checkout will not load — an ad blocker eating checkout.js is
    // common enough that a page with no other way to pay is a lost donation.
    url: SUPPORT_URL,
    keyId: RZP_READY ? RZP_KEY_ID : '',
    // The lowest amount the server will create an order for, so the custom
    // field can say so before the reader submits it.
    min: minorPerMajor(CURRENCY),
  };
}

/** Amounts the server is willing to charge. */
function validAmount(amount) {
  const n = Number(amount);
  if (!Number.isInteger(n)) return null;
  const floor = minorPerMajor(CURRENCY);            // one major unit
  const ceiling = 500_000 * minorPerMajor(CURRENCY); // a sanity limit, not a policy
  if (n < floor || n > ceiling) return null;
  return n;
}

/**
 * Create a Razorpay order.
 *
 * The amount is fixed here rather than accepted from the browser at capture
 * time — Checkout is handed an order id, and the order carries the amount, so
 * a reader editing the JavaScript changes nothing that reaches the bank.
 */
async function createOrder({ amount, userId = null, note = '' }) {
  if (!RZP_READY) throw new Error('Payments are not configured.');
  const value = validAmount(amount);
  if (!value) throw new Error('That amount is out of range.');

  const receipt = `ad_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;

  const response = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(`${RZP_KEY_ID}:${RZP_KEY_SECRET}`).toString('base64')}`,
    },
    body: JSON.stringify({
      amount: value,
      currency: CURRENCY,
      receipt,
      notes: { site: 'afterdark', note: String(note || '').slice(0, 200) },
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    // Razorpay's own message is the useful one — a currency the account cannot
    // accept, or a key that is live when the dashboard is in test mode.
    throw new Error(body?.error?.description || `Razorpay refused the order (${response.status}).`);
  }

  db.prepare(
    `INSERT INTO donations (order_id, receipt, amount, currency, status, user_id, note, created_at)
     VALUES (?, ?, ?, ?, 'created', ?, ?, ?)`
  ).run(body.id, receipt, value, CURRENCY, userId, String(note || '').slice(0, 200), Date.now());

  return { orderId: body.id, amount: value, currency: CURRENCY, keyId: RZP_KEY_ID };
}

/**
 * Verify a completed payment.
 *
 * Razorpay signs `order_id|payment_id` with the key secret. Comparing with
 * `timingSafeEqual` rather than `===` because this is a signature check and a
 * string compare that returns early leaks how much of a forgery was right.
 */
function verifyPayment({ orderId, paymentId, signature }) {
  if (!RZP_READY) return false;
  if (!orderId || !paymentId || !signature) return false;

  const expected = crypto
    .createHmac('sha256', RZP_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');

  const given = Buffer.from(String(signature), 'utf8');
  const want = Buffer.from(expected, 'utf8');
  if (given.length !== want.length) return false;
  if (!crypto.timingSafeEqual(given, want)) return false;

  db.prepare(
    `UPDATE donations SET status = 'paid', payment_id = ?, paid_at = ?
     WHERE order_id = ? AND status != 'paid'`
  ).run(paymentId, Date.now(), orderId);

  return true;
}

/** What the site can honestly say it has raised. Paid rows only. */
function totals() {
  const row = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total
       FROM donations WHERE status = 'paid' AND currency = ?`
  ).get(CURRENCY);
  return {
    supporters: row.n,
    raised: row.total,
    display: format(Math.round(row.total / minorPerMajor(CURRENCY))),
  };
}

module.exports = {
  config, tiers, createOrder, verifyPayment, totals, validAmount,
  ENABLED, CURRENCY, RZP_READY, SUPPORT_URL,
};
