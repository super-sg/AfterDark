'use strict';

/**
 * The directory.
 *
 * A browsable index of adult platforms, grouped by what they actually are —
 * because "porn site" covers a tube aggregator, a studio subscription, a cam
 * platform and a creator marketplace, and those are four completely different
 * things with four different business models and four different relationships
 * with the people who appear on them.
 *
 * Everything here is a mainstream, legally-operating platform. What is
 * deliberately absent: leak sites, "free premium" aggregators, and anything
 * whose business is redistributing other people's paid work. Those are the
 * sites the industry press in the newsroom spends its time suing, and putting
 * them in a directory on the same site would be incoherent.
 */

const { db } = require('./db');

const CATEGORIES = [
  { key: 'tube', label: 'Tube sites', blurb: 'Free, ad-supported, enormous. Where most traffic goes.' },
  { key: 'studio', label: 'Studios', blurb: 'Subscription networks producing their own scenes.' },
  { key: 'creator', label: 'Creator platforms', blurb: 'Performers selling directly, keeping most of it.' },
  { key: 'cam', label: 'Cam and live', blurb: 'Live streaming, tipped and per-minute.' },
  { key: 'jav', label: 'JAV', blurb: 'Japanese adult video — official distributors and labels.' },
  { key: 'hentai', label: 'Hentai and eroge', blurb: 'Licensed adult manga, animation and visual novels.' },
  { key: 'trade', label: 'Trade press', blurb: 'Who covers the business. Not adult content itself.' },
];

const CATEGORY_KEYS = new Set(CATEGORIES.map((c) => c.key));

/** Seed set: mainstream platforms, each the obvious example of its category. */
const SEED = [
  ['Pornhub', 'https://www.pornhub.com', 'tube', 'The largest tube site; owned by Aylo.'],
  ['XVideos', 'https://www.xvideos.com', 'tube', 'Consistently the highest-traffic adult site by raw visits.'],
  ['xHamster', 'https://xhamster.com', 'tube', 'Tube plus a large amateur and community layer.'],
  ['YouPorn', 'https://www.youporn.com', 'tube', 'Aylo-owned; shares an index with Pornhub.'],
  ['RedTube', 'https://www.redtube.com', 'tube', 'Long-running Aylo tube property.'],
  ['EPorner', 'https://www.eporner.com', 'tube', 'Independent tube; publishes a public metadata API.'],
  ['SpankBang', 'https://spankbang.com', 'tube', 'Independent tube with a heavy mobile audience.'],

  ['Brazzers', 'https://www.brazzers.com', 'studio', 'Aylo’s flagship studio brand.'],
  ['Reality Kings', 'https://www.realitykings.com', 'studio', 'Long-running network, now under Aylo.'],
  ['Bang Bros', 'https://bangbros.com', 'studio', 'Independent Miami studio, thirty-odd sites.'],
  ['Naughty America', 'https://www.naughtyamerica.com', 'studio', 'Early adopter of VR production.'],
  ['Vixen Media Group', 'https://www.vixen.com', 'studio', 'Blacked, Tushy, Deeper — high-budget cinematic.'],
  ['Adult Time', 'https://www.adulttime.com', 'studio', 'Gamma’s streaming bundle; features and series.'],
  ['Kink.com', 'https://www.kink.com', 'studio', 'BDSM studio, unusually public about consent process.'],
  ['Evil Angel', 'https://www.evilangel.com', 'studio', 'Director-led catalogue going back to the 1980s.'],

  ['OnlyFans', 'https://onlyfans.com', 'creator', 'The subscription platform that reshaped the industry.'],
  ['Fansly', 'https://fansly.com', 'creator', 'Main OnlyFans competitor; more permissive tiers.'],
  ['ManyVids', 'https://www.manyvids.com', 'creator', 'Clip marketplace plus subscriptions and customs.'],
  ['Clips4Sale', 'https://www.clips4sale.com', 'creator', 'The original fetish clip marketplace, 2003.'],
  ['LoyalFans', 'https://www.loyalfans.com', 'creator', 'Subscription and clips, creator-owned.'],

  ['Chaturbate', 'https://chaturbate.com', 'cam', 'Token-tipped freemium cams; the biggest by traffic.'],
  ['Stripchat', 'https://stripchat.com', 'cam', 'Freemium cams with heavy VR and interactive-toy support.'],
  ['LiveJasmin', 'https://www.livejasmin.com', 'cam', 'Premium per-minute model, Docler-owned.'],
  ['BongaCams', 'https://bongacams.com', 'cam', 'Large European freemium platform.'],
  ['Cam4', 'https://www.cam4.com', 'cam', 'Long-running freemium cam site.'],

  ['FANZA (DMM)', 'https://www.dmm.co.jp/digital/', 'jav', 'Japan’s main legal digital distributor for JAV.'],
  ['SOD Create', 'https://ec.sod.co.jp', 'jav', 'Soft On Demand — major Tokyo label and studio.'],
  ['MGS Video', 'https://www.mgstage.com', 'jav', 'Distributor carrying many independent labels.'],
  ['Caribbeancom', 'https://www.caribbeancom.com', 'jav', 'Uncensored label operating outside Japan.'],

  ['FAKKU', 'https://www.fakku.net', 'hentai', 'Licensed, translated adult manga — pays the artists.'],
  ['Irodori Comics', 'https://irodorimanga.com', 'hentai', 'Licensed doujin translations, creator-split.'],
  ['JAST USA', 'https://jastusa.com', 'hentai', 'Longest-running English eroge and visual-novel publisher.'],
  ['MangaGamer', 'https://www.mangagamer.com', 'hentai', 'Licensed adult visual novels and eroge.'],

  ['XBIZ', 'https://www.xbiz.com', 'trade', 'Business news, awards and conferences.'],
  ['AVN', 'https://avn.com', 'trade', 'Adult Video News — the trade paper of record.'],
  ['YNOT', 'https://www.ynotmag.com', 'trade', 'Industry news with a webmaster and affiliate focus.'],
  ['Free Speech Coalition', 'https://www.freespeechcoalition.com', 'trade', 'The industry’s US trade association and lobby.'],
  ['ASACP', 'https://www.asacp.org', 'trade', 'Association of Sites Advocating Child Protection.'],
];

function seed() {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM sites').get().n;
  if (existing) return 0;
  const insert = db.prepare(
    `INSERT INTO sites (name, url, category, blurb, nsfw, sort_order, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const now = Date.now();
  const tx = db.transaction(() => {
    SEED.forEach(([name, url, category, blurb], i) => {
      insert.run(name, url, category, blurb, category === 'trade' ? 0 : 1, i, now);
    });
  });
  tx();
  return SEED.length;
}

function all() {
  const rows = db.prepare(
    'SELECT id, name, url, category, blurb, nsfw, clicks FROM sites WHERE hidden = 0 ORDER BY category, sort_order, name'
  ).all();
  return CATEGORIES.map((c) => ({
    ...c,
    sites: rows.filter((r) => r.category === c.key).map((r) => ({ ...r, nsfw: !!r.nsfw })),
  })).filter((c) => c.sites.length);
}

function add({ name, url, category, blurb = '', nsfw = true, userId = null }) {
  if (!CATEGORY_KEYS.has(category)) return null;
  return Number(db.prepare(
    `INSERT INTO sites (name, url, category, blurb, nsfw, sort_order, added_by, created_at)
     VALUES (?, ?, ?, ?, ?, 999, ?, ?)`
  ).run(name, url, category, blurb, nsfw ? 1 : 0, userId, Date.now()).lastInsertRowid);
}

function hide(id) {
  return db.prepare('UPDATE sites SET hidden = 1 WHERE id = ?').run(id).changes;
}

/** Outbound clicks, so the directory can order itself by what people use. */
function click(id) {
  return db.prepare('UPDATE sites SET clicks = clicks + 1 WHERE id = ?').run(id).changes;
}

module.exports = { CATEGORIES, CATEGORY_KEYS, seed, all, add, hide, click };
