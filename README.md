# AfterDark

A Reddit-style discussion community **and** newsroom for the adult industry: threaded posts with
upvoting, board-based communities, and a news section combining staff reporting with an aggregated
trade wire.

Text discussion only. No explicit media is hosted, uploaded or linked.

---

## What already exists (research before building)

The brief was "a Reddit-like site for discussing porn, with news". That space is not empty, but it
is split — nobody does both halves well:

| Existing | What it is | Gap |
| --- | --- | --- |
| [r/pornfree, r/Porn_Discussion etc.](https://www.reddit.com) | Reddit's own subreddits, ~200k subscribers on the largest | Sits inside Reddit's policy regime; adult subs are deranked, unsearchable and periodically purged. No news layer. |
| [Adult DVD Talk](https://adultdvdtalk.com) | Fan/insider forum running since 1999 | Classic phpBB-era forum: flat threads, no voting, poor mobile. Community is strong, software is 20 years old. |
| [XBIZ](https://www.xbiz.com) / [AVN](https://avn.com) | The two trade publications | Excellent reporting, but they are publishers — comments are an afterthought and there is no community structure. |
| [YNOT](https://www.ynotmag.com), Mike South | Smaller trade press | Same shape: news out, no discussion in. |
| [Lemmy](https://github.com/LemmyNet/lemmy), Postmill | Open-source Reddit clones | Structurally right (communities, threading, votes) but general-purpose: no age assurance, no adult-specific moderation floor, no newsroom. |

**The gap this fills:** Reddit's threading model and the trade press's reporting in one place, with
the age-assurance and moderation architecture that an adult-adjacent site needs from day one — which
is precisely what neither the forums nor the publishers have.

---

## Feature set

**Reddit-style discussion**
- Boards (communities) with their own rules, accents, and subscriber counts
- Text and link posts, upvote/downvote with score, karma tracked per user
- Arbitrarily nested comment threads with collapse, sorted by **best** (Wilson score lower bound),
  top, new, old or controversial — the same algorithms Reddit publishes
- Feed sorts: **hot** (score decayed by age), new, top (per time window), rising (score velocity)
- Full-text search over titles and bodies (SQLite FTS5, BM25-ranked)
- Profiles with post/comment history, subscriptions, pinned and locked threads

**Newsroom and the Wire**
- Staff-published reporting in `The Newsroom` and `Law & Policy`, comments open on every story
- **A config-driven source registry** (`src/sources.js`): every external feed is declared as data —
  adapter, URL, target board, NSFW flag, and for JSON APIs a declarative field map. A publisher
  renaming a field is a config edit, not a patch, and an operator can add a source at runtime
- **Two adapters** (`src/feedparse.js`): RSS/Atom, and a generic JSON adapter driven by dotted
  paths with one array projection (`tags[].tag_name`)
- **robots.txt is read and honoured** before every fetch (`src/robots.js`) — group selection by
  user-agent, longest-match-wins Allow/Disallow, wildcards, end-anchors, Crawl-delay
- **Relevance filters**: a source may declare the terms an item must touch before it is filed.
  Tokyo Reporter covers Japanese news of which the adult industry is a slice; Anime News Network
  covers all animation, of which adult animation is a corner. Without the filter a road-accident
  report lands on the JAV desk. An honestly quiet board beats a full one about something else
- **Health is inspectable**: `npm run wire -- --status`, plus a rail panel and a self-explaining
  empty state naming exactly which sources are unreachable and why
- Only headline, source, timestamp, thumbnail URL and a short summary are stored — full articles
  and every media file stay on the publisher's site, where attribution and ad revenue belong

**Trending video**
- `The Reel` pulls trending-clip metadata from tube-site JSON APIs: title, thumbnail, runtime,
  view count, tags and a link. Nothing is hosted, mirrored or embedded — the thumbnail links out
  to the publisher, the title links to the discussion here
- A **media-first theatre grid** with runtime badges and publisher-reported view counts, sorted by
  *most watched* rather than by our own votes, which say nothing about a clip nobody here has seen
- Hentai and JAV get their own boards, both filtered as above

**Explicit media, and the gate in front of it**

Adults-only settles whether a reader *may* see explicit artwork. It does not settle whether it
should arrive unannounced in a scrolling feed, so:

- The image proxy renders a **blurred twin of every visual preset** — downscaled to 18%, blurred,
  re-encoded. A blurred card is ~550 bytes against ~24 KB sharp
- The preset name is inside the HMAC, so a signature for the blurred rendition **cannot be replayed
  to fetch the sharp one** (verified: preset swap returns 403)
- Both URLs ship with the payload, so revealing is a `src` swap with no round trip. Per-card reveal
  lasts the session; "Show all" persists. The gate stops an ambush, it does not keep a secret from
  an adult who asked to be here

**Pictures, and where they come from**

The site hosts no media, so every image is the linked page's own Open Graph
artwork — the same mechanism behind X's and Reddit's link cards, and the reason
[a card earns multiples of a bare link's engagement](https://og-image.org/docs/platforms/twitter).

- **Open Graph scraper** (`src/media.js`) reads `og:image`, `twitter:image`, title,
  description and publication date, stopping the download at `</head>`
- **Signed image proxy** (`src/imageproxy.js`) re-serves every picture from our own origin,
  resized to the slot the layout renders and re-encoded to WebP — a 1200×630 hero becomes a
  24 KB card or a 10 KB thumbnail
- **Video**: YouTube and Vimeo links become click-to-play players. Nothing loads from either
  host until the reader presses play, and then only via `youtube-nocookie`
- **Generated covers**: a text post with no picture gets a deterministic board-coloured square
  derived from its id, so the feed has rhythm without inventing fake photography
- **Dominant-colour tints** fill the image box before the picture arrives, so cards do not flash

Why proxy rather than hotlink: the reader's browser never contacts a publisher's CDN, so no third
party learns which adult-industry stories a given IP reads. On this site that is not a nicety.
It also keeps `img-src 'self'` intact and makes dead hotlinks impossible.

**Design and retention**

- **Three feed views** — card, compact, classic — the [three Reddit ships](https://www.digitaltrends.com/computing/reddit-redesign-launches-to-first-users/), remembered per reader
- **Newsroom** leads with a full-bleed hero (chosen partly for its art, like a real front page),
  then a two-up grid, then a compact wire list
- **Infinite scroll** via IntersectionObserver, with the Load-more button kept in place —
  [NN/g's point](https://www.nngroup.com/articles/infinite-scrolling-tips/) is that a pure infinite feed strands anyone who wants the footer
- **Scroll restoration**, so Back lands where you left off
- **Trending** ranks by *recent comment activity*, not score: a 400-point thread nobody is
  replying to is finished; a 40-point thread with 30 fresh replies is where the conversation is
- **Saves**, **related threads** under every post, **reading-time** estimates
- **Emoji reactions** alongside the vote, not replacing it: the vote decides ranking, the reaction
  says something *about* a post. Most readers will never write a comment, and one tap is the
  contribution they will actually make. The row stays collapsed until someone starts
- **Topics**, derived rather than curated. Publisher categories plus proper nouns lifted from
  headlines, so a performer, studio or statute trends exactly while the press is writing about it
  and stops when coverage moves on. Nobody here maintains a list of people
- **"N new posts" pill** — polling a count is far cheaper than re-running the feed, so the reader
  is told and decides, rather than having the page pulled out from under them mid-scroll
- **Keyboard shortcuts**: `j`/`k`, `u`/`d`, `s`, `/`, `g h`, `v`, `?`

**Why topic extraction is harder than it looks**

Extraction leans on capitalisation to tell a subject from an ordinary word. In a Title Case
headline — which is half the trade press — capitalisation carries no information at all, and a
naive extractor reports "Verification Law Takes" as a subject with total confidence. So the
extractor measures whether a headline is Title Case and, when it is, falls back to shouted
acronyms only. A wrong topic is worse than a missing one: it becomes a page, a filter and a trend
nobody meant. `test/wire.test.js` pins this down.

**Type and icons**

Inter for UI, Newsreader for headlines — both self-hosted (352 KB total, `unicode-range`-split so
only latin loads). No Google Fonts request, which keeps the CSP tight and leaks nothing. Icons are
a hand-built 24×24 flat line set rendered inline (`public/js/icons.js`); there is not a single
emoji left in the interface.

**Safety and moderation** (see [Legal reality](#legal-reality-read-this-before-deploying))
- Age interstitial, signed cookie, pluggable to a real age-assurance vendor
- Two-tier content screening: hard blocks that reject at submission and log, soft flags that queue
  for a human
- Report button on every post and comment, moderator queue, public mod log, ban tooling
- Per-action rate limits (posting, commenting, voting, reporting, registration, login)

---

## Running it

```bash
npm install
cp .env.example .env          # then set SESSION_SECRET — see below
npm run seed                  # boards, staff accounts, 10 starter threads
npm run wire                  # optional: pull live headlines from the trade press
npm start                     # http://localhost:8080
```

> The `.env` in this checkout is set to **port 4173**, because Docker already holds 8080 on this
> machine. Change `PORT` to whatever is free for you.

Generate a real session secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Seeded demo accounts all use the password `afterdark-demo-2026` (override with `SEED_PASSWORD`).
Sign in as **admin** for moderator tools; **newsdesk** publishes to the newsroom.

Other scripts:

```bash
npm test           # 84 tests: screening, ranking, store, media, feeds, robots, topics
npm run dev        # single process, --watch reload
npm run wire       # pull every enabled source once, now
npm run wire -- --status  # registry + health, fetch nothing
npm run wire -- xbiz avn  # pull only these sources
npm run seed -- --reset   # wipe content and reseed
npm run loadtest -- --users 1000 --seconds 20
```

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `SESSION_SECRET` | *(required in production)* | Signs session and age cookies |
| `DB_PATH` | `./data/afterdark.db` | SQLite file location |
| `CLUSTER` | `auto` | Worker count. `auto` = cores − 1, capped at 8. `0`/`1` = single process |
| `TRUST_PROXY` | `0` | Set to `1` behind nginx/Cloudflare so rate limits read `X-Forwarded-For` |
| `ADMIN_USERS` | `admin` | Comma-separated names granted admin on registration |
| `AGE_ASSURANCE_MODE` | `self` | `self` (interstitial) or `vendor` (delegate to `AGE_VERIFY_URL`) |
| `WIRE_AUTO` | on | Set `0` to disable automatic wire polling |
| `WIRE_INTERVAL_MS` | `600000` | How often the wire polls. Floor of 60s. |
| `WIRE_USER_AGENT` | `AfterDarkWire/2.0 …` | Sent on every outbound fetch and matched against robots.txt |

---

## Architecture

```
server.js            cluster primary + worker: helmet, compression, static, scheduled jobs
src/
  env.js             .env loading, secret enforcement
  db.js              SQLite schema, WAL/pragma tuning, FTS triggers, migrations
  ranking.js         hot rank, Wilson confidence, rising velocity
  store.js           every query, prepared once; keyset pagination
  auth.js            scrypt passwords, hashed session tokens, signed age cookie
  moderation.js      hard-block / soft-flag screening, sanitising, rate limits
  media.js           Open Graph scraper, video recognition, SSRF guard
  imageproxy.js      signed image proxy: fetch, resize, WebP + blurred twins, disk cache
  enrich.js          background media enrichment and proxy warm-up
  sources.js         the source registry: declarations, filters, health
  robots.js          robots.txt fetch, parse and longest-match evaluation
  feedparse.js       RSS/Atom parser + declarative JSON adapter
  topics.js          derived topics: publisher categories + headline proper nouns
  wire.js            ingestion: fetch, filter for relevance, screen, file
  routes.js          the HTTP API
  cache.js           TTL + LRU micro-cache
public/
  css/app.css        one stylesheet
  fonts/             self-hosted Inter + Newsreader (woff2)
  js/                zero-build ES modules — app, ui, icons, api, util
scripts/             seed.js, fetch-wire.js, loadtest.js
test/                node:test suites — moderation, ranking, store
```

**Outbound requests are the risk surface here.** A link post is an instruction to make an HTTP
request from inside our network, so `src/media.js` resolves DNS and refuses loopback, RFC1918,
CGNAT, link-local and cloud-metadata addresses — re-validating on every redirect hop, because
`evil.com → 127.0.0.1` otherwise walks straight through. The proxy is HMAC-signed so it cannot be
pointed at arbitrary hosts by a third party.

**Why SQLite.** A discussion site is overwhelmingly read-heavy, and reads never leave the process —
no network hop, no connection pool, no serialisation. In WAL mode every worker reads concurrently
while one writes. This carries a community of this size on a single machine, and the schema ports to
Postgres unchanged if you ever outgrow one box.

**How it stays fast under load:**
- **Keyset pagination.** Feeds page by `(sort key, id)` cursor, never `OFFSET`. Page 500 costs the
  same as page 1.
- **Shared feed cache.** The expensive part of a feed response is identical for every viewer, so it
  is cached for 4 seconds; the viewer's own votes are stitched on afterwards from one indexed
  lookup. A burst of readers collapses into a handful of queries.
- **Covering indexes** for each sort order, per board and site-wide.
- **Materialised comment paths.** The whole tree comes back in one indexed query, already in
  parent-before-child order; the tree is assembled in a single pass.
- **Counters, not aggregates.** Scores, comment counts and rank columns are updated inside the same
  transaction as the vote, so no read ever runs a `COUNT`.
- **One process per core**, sharing the port via the OS load balancer.

### Measured performance

MacBook (10 cores), 8 workers, SQLite on local disk:

| Test | Result |
| --- | --- |
| **1000 concurrent browsing users**, realistic mix, ~900 ms think time | **1005 req/s, 0 failures**, p95 1.5 ms, **p99 7 ms**, 101 MB served |
| Saturation (`--hammer`, 500 connections, no think time) | **18,443 req/s**, p99 64 ms |
| Cached proxied image | 24 KB WebP, served `immutable`, straight off disk |

So the target of 1000 simultaneous users is met with roughly 18× headroom on one machine. Reproduce
with `npm run loadtest -- --users 1000 --seconds 20` (run the server with `TRUST_PROXY=1`, since the
generator presents a distinct `X-Forwarded-For` per virtual user — otherwise the per-IP limiter
correctly rejects the whole test as one abusive client).

---

## Legal reality (read this before deploying)

This is the part most builds of this kind get wrong, so it is stated plainly.

**Age verification is now mandatory across most of the US and the UK.** As of mid-2026, 26 US states
require age verification for sites with a "substantial portion" of adult content — a third of the
content in most states, a quarter in Kansas. The Supreme Court upheld the Texas statute in June 2025,
so the constitutional challenge is spent. Penalties run to $10,000/day (Louisiana) and $250,000
where a minor actually gained access (Arizona). The UK Online Safety Act requires "highly effective
age assurance", enforced by Ofcom, with penalties up to 10% of global revenue.

**The interstitial in this codebase is not compliant on its own.** A self-declared "I am 18+" click
is explicitly insufficient under every one of those regimes. It is included because it is the right
*shape* — signed, expiring, enforced server-side on every content endpoint — and because it is the
integration point. Before operating publicly, set `AGE_ASSURANCE_MODE=vendor` and wire
`AGE_VERIFY_URL` to a real provider (Yoti, VerifyMy, AgeChecked, Incode and others serve this
market). Prefer double-blind attestation: your server should learn *that* the user is an adult and
never *who* they are, because a per-access verification log is a breach liability and a subpoena
target.

### The hardest part of the filter is not what it blocks

The site's subject matter *is* the vocabulary of the things it prohibits. "Material harmful to
minors" is the operative phrase in every US age-verification statute. "Child sexual abuse material"
is what the enforcement literature calls the thing. "Non-consensual intimate images" is the language
of the TAKE IT DOWN Act. A naive proximity filter reads every one of those as a violation and
silently makes the site unable to discuss its own legal position.

The first implementation here did exactly that: pointed at the live Free Speech Coalition feed, it
rejected the West Virginia age-verification story, the TAKE IT DOWN Act explainer, and a piece about
integrating StopNCII — all of them squarely on-topic. So `src/moderation.js` screens in two passes:

1. **Proximity** — minor-related terms next to sexual nouns are rejected outright, but only after
   statutory terms of art are masked out. The cost asymmetry justifies false positives here.
2. **Supply** — every other category is rejected only alongside solicitation language ("links",
   "anyone got", "dm me", "mega folder"), checked against unmasked text so wrapping a request in
   legal vocabulary launders nothing. Words that saturate policy writing — *share*, *download*,
   *request*, *collection* — are deliberately excluded as supply signals, and a prevention frame
   ("prevent the sharing of…") neutralises the rest.

`test/moderation.test.js` pins both directions, with verbatim trade-press copy as the regression
fixtures. That file is the specification; read it before touching the patterns.

**Other obligations this design assumes you will meet:**
- **Content moderation is not a filter.** `src/moderation.js` is a floor — high-precision rejection
  of the categories that are never acceptable, plus a queue. It is not a substitute for human
  moderators.
- **If you ever add image hosting**, you take on obligations this codebase does not implement: hash
  matching against known CSAM (PhotoDNA, Cloudflare's CSAM Scanning Tool, Thorn Safer) and a
  reporting relationship with your jurisdiction's authority (NCMEC in the US, IWF in the UK). Do not
  build that yourself.
- **US 18 U.S.C. §2257** record-keeping attaches to depictions of actual sexually explicit conduct.
  A text discussion site does not trigger it; adding media does.
- **Payment processing.** Card networks classify by *subject matter*, not just content — discussion
  platforms about adult topics have been categorised as high-risk. Budget time to find an acquirer.
- **Data protection.** Age tokens, IP addresses and session records are personal data under GDPR/UK
  GDPR. The schema deliberately stores no email addresses and hashes session tokens.

None of this is legal advice. Get a lawyer in each jurisdiction you serve before launching.

---

## Communities

Anyone can found one. `/create` takes an address, a name, and — mandatorily —
at least one rule, because of what rules are for here.

**Rules are rows, not prose, and every removal must cite one.**

On most forums a rule is a line in a sidebar and a removal is free text, so
nobody can tell whether a rule is enforced, enforced unevenly, or dead letter.
Here each rule is a numbered row with a public citation counter. A community
moderator removing a post picks the rule it broke; the counter moves; the
enforcement appears in a public log against that rule.

What that buys:

- A rule cited four hundred times and a rule cited never are visibly different
  objects, on the community page, to everyone.
- A community can see its own moderation drifting — one rule doing all the work
  usually means it is being used as a catch-all.
- Removals cannot be justified after the fact, because the citation is part of
  the action rather than a note attached to it.
- Rules **retire**, never delete. Past removals cite them, and a moderation
  record pointing at a rule that no longer exists is worse than no record.

The API enforces it: `POST /api/communities/:slug/moderate` with
`action: "remove"` and no valid `ruleId` is a 400, and a rule belonging to a
different community is also a 400.

| | |
| --- | --- |
| `board_mods` | owner + moderators per community; the owner seat only moves by transfer |
| `board_rules` | numbered, with `cited_count` and `retired_at` |
| `mod_actions` | gains `board_id` and `rule_id`, so the log is attributable |

Site desks (the newsroom, the wire boards, The Reel) are marked `official` and
configured in `scripts/seed.js`; user-founded communities are configured by
their owner at `/b/<slug>/settings`.

Slugs are 3–24 characters, lowercase, and a reserved list keeps `api`, `admin`,
`new`, `all` and friends out of the namespace.

---

## Accounts and the social layer

`src/social.js` holds the parts of a forum that are about people rather than
posts. All five are small, user-scoped, write-on-event tables the feed layer
never touches.

**Inbox** (`/inbox`) — replies, comment-replies, `@mentions`, awards, and any
moderator removal of your own content *with the rule it cited*. Written when the
event happens rather than derived on read, and deduplicated: replying to the OP
inside their own thread while also `@`-ing them is one event, not three.

**Messages** (`/messages`) — one conversation row per pair, stored with the ids
ordered so `(a,b)` and `(b,a)` cannot diverge. Opening a thread marks it read.
A third party asking for someone else's conversation gets a 404, not a 403 —
there is nothing to confirm.

**Awards** — five named awards, and every account gets **five a month**.
Deliberately not a currency: a paid award is a way to buy visibility, which is
exactly what a vote is supposed to measure. Giving one costs attention instead.

**Custom feeds** (`/feeds`, read at `/f/<slug>`) — a named set of communities
read as one feed, for when "everything I follow" is two interests fighting over
one screen.

**Blocking** — one-directional on purpose. It hides the blocked account's posts
from the blocker and stops them sending messages; it does **not** hide the
blocker from them. A block should never be a way to make yourself unreadable to
somebody documenting your behaviour.

**Settings** (`/settings`) — bio, reading preferences (which follow the account
rather than the browser), password change, and the block list. Changing a
password ends every other session, because that is what someone does when they
think another person has the old one.

### A bug this shipped with, and the fix

Votes, saves, reactions and awards reference posts *polymorphically* —
`(target_type, target_id)` rather than a real foreign key — so SQLite cannot
cascade them. Hard-deleting a post orphaned its votes; SQLite then recycled the
freed rowid for the next post, and the new author's automatic self-upvote
collided with a stranger's vote on a row that no longer existed. Every post
creation 500'd.

Fixed in three places: `posts_cleanup` / `comments_cleanup` triggers do the
cascade the schema cannot express, the self-upvote uses `INSERT OR REPLACE` so
a pre-existing orphan cannot break a write, and the orphans already in the
database were purged with the vote counters recomputed.

---

## Interface

Dark by default, light on a toggle, remembered per reader. The palette is one
electric accent against near-black — the accent only works there, so the light
theme keeps it as a *fill* with dark ink and switches to a deep olive wherever
the accent has to be text. Both themes are token blocks in `public/css/app.css`;
no colour is hardcoded outside them, and `public/js/theme.js` applies the stored
choice before first paint so there is no flash of the wrong theme.

The type does the rest of the work: uppercase micro-labels at 10px with 0.14em
tracking against tight, heavy display headings, and hard-edged chrome (7px
radius) instead of soft consumer roundels.

The feed is a Reddit/X hybrid rather than a magazine:

- **Rows, not cards.** One surface, hairline separators, border on `:hover` —
  a bordered box per post turns a timeline into a stack of floating rectangles.
- **Sans headlines.** The serif is kept for article pages and the newsroom hero.
  A feed is scanned; 30px Newsreader is beautiful and unscannable.
- **Side thumbnail with an expando.** Clicking the thumbnail grows it into a
  banner in place — no fetch, no navigation, no lost scroll position. This is
  the single decision that took the feed from two posts per screen to five.
- **No picture unless there is one.** The generated gradient covers cost 130px
  a row and told the reader nothing.
- **A composer bar** at the top of every feed: a text box you can imagine
  typing in converts far better than a button marked "submit".

## Ads

Slots are declared in `src/ads.js` and rendered as `<iframe>` elements pointing
at `/ads/:slot` on our own origin, sandboxed with `allow-scripts allow-popups`
and deliberately **without** `allow-same-origin`.

That last omission is the whole design. Ad tags are third-party script, and the
site otherwise runs under `script-src 'self'` precisely so that a session cookie
on an adult site is not exposed to whatever an ad network ships this week. Inside
an opaque-origin sandbox the tag renders and can open its click-through, but it
cannot read `document.cookie`, reach the parent DOM, or learn anything about the
reader. The main document's CSP never names an ad host; the frame carries its own,
listing exactly two.

Every slot reserves its declared size before anything loads, so a late ad drops
into a waiting box instead of shoving the article down — the largest single
source of layout shift on an ad-supported site.

| Slot | Unit | Where |
| --- | --- | --- |
| `top` | 728×90 / 320×50 | above the feed |
| `rail` | 300×250 | right rail |
| `article` | 468×60 / 320×50 | under the post body |
| `feed` | native widget | every 7th row |
| `footer` | 728×90 / 320×50 | available, not placed |

Set `ADS_ENABLED=0` to remove them entirely — no empty boxes, no requests.

---

## API

All endpoints are under `/api`. Content endpoints require the age cookie; mutations require a
session and same-origin.

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/age/confirm` | Sets the signed age cookie |
| `POST` | `/auth/register`, `/auth/login`, `/auth/logout` | scrypt; sessions in an httpOnly cookie |
| `GET` | `/me` | Viewer, age state, subscriptions |
| `GET` | `/boards`, `/boards/:slug` | Board list and detail with pinned posts |
| `POST` | `/boards/:slug/subscribe` | Toggles subscription |
| `GET` | `/feed?sort=&board=&t=&scope=&cursor=` | `sort` = hot/new/top/rising |
| `GET` | `/search?q=` | FTS5 |
| `POST` `GET` `PATCH` `DELETE` | `/posts`, `/posts/:id` | Create, read (with comment tree), edit, delete |
| `POST` | `/posts/:id/comments` | `parentId` for replies |
| `PATCH` `DELETE` | `/comments/:id` | Author or staff |
| `POST` | `/posts/:id/vote`, `/comments/:id/vote` | `value` = 1, 0 or -1 |
| `GET` | `/news`, `/news/ticker` | Newsroom feed and headline strip |
| `POST` | `/news/refresh` | Staff: pull the trade feeds now |
| `GET` | `/users/:username` | Public profile |
| `POST` | `/report` · `GET` `/mod/queue` · `POST` `/mod/action`, `/mod/ban` | Reporting and moderation |
| `GET` | `/stats`, `/health` | Community counters; liveness and cache stats |

---

## Deployment notes

- Put nginx or Cloudflare in front, terminate TLS there, and set `TRUST_PROXY=1`.
- Set `NODE_ENV=production` — this enforces `SESSION_SECRET` and marks cookies `Secure`.
- The SQLite file plus its `-wal` and `-shm` siblings are the entire database. Back up with
  `sqlite3 data/afterdark.db ".backup backup.db"`, which is safe against a live writer.
- The RTA label header (`Rating: RTA-5042-...`) is set on every response so filtering software can
  classify the site correctly.
- Scale up before scaling out: this design is single-node by construction. If you genuinely outgrow
  one machine, move the rate-limit store to Redis and `src/store.js` to Postgres — the query shapes
  are already compatible.
