# Migrating to afterdark.pornsexvideo.org

The app currently answers on the apex domain, `pornsexvideo.org`. This moves it
to `afterdark.pornsexvideo.org` and turns the apex into a static welcome page
that sends readers there.

Everything below is done from cPanel on the `olenspro` account
(`teesta-bd-cp4.hostever.us:2083`). Nothing here needs a rebuild — the code
changes are already in the repo, so §2 is a `git pull` and the rest is
configuration.

---

## 0. Fix the ads first — the site is currently earning nothing

**This is independent of the migration and worth doing before anything else.**

`ADS_ORIGIN` is set on the ads-only application but **not** on the main one.
Read off the live site:

```console
$ curl -s https://pornsexvideo.org/api/ads | grep -o '"origin":"[^"]*"'
"origin":""
```

The consequence, from the reasoning in `src/ads.js`: with no `ADS_ORIGIN`, ad
frames are served from the site's own host and sandboxed *without*
`allow-same-origin`, so the tag inside runs at an opaque origin. Adsterra's tag
probes for `localStorage` before it will serve, an opaque origin makes that
throw, and a tag that finds no storage returns nothing.

And because unfilled slots collapse to zero height by design, **the failure is
invisible**: the site looks deliberately ad-free while earning nothing. Every
banner on every page has been in this state.

The ads host itself is already up and correctly configured — `ads.pornsexvideo.org`
serves frames and nothing else. Only the main app was never told to use it.

**Fix:** cPanel → **Setup Node.js App** → the main application → add:

| Variable | Value |
|---|---|
| `ADS_ORIGIN` | `https://ads.pornsexvideo.org` |

Restart the app. Then confirm it took:

```console
$ curl -s https://pornsexvideo.org/api/ads | grep -o '"origin":"[^"]*"'
"origin":"https://ads.pornsexvideo.org"
```

The `sandbox` field in the same response should now include `allow-same-origin`.

---

## 1. Create the subdomain

cPanel → **Domains** → Create a Domain → `afterdark.pornsexvideo.org`.

The document root is already there: `/home/olenspro/afterdark.pornsexvideo.org`.
It currently serves an empty directory listing, which is how you can tell
nothing has been deployed to it yet.

---

## 2. Pull the code

cPanel → **Git™ Version Control** → the existing repository → **Update from
Remote**. This brings in the exit interstitial, the support page and the
welcome page.

Then **Setup Node.js App** → **Run NPM Install** (nothing new was added to
`package.json`, so this is a no-op — run it anyway rather than assuming).

---

## 3. Point the application at the subdomain

**Setup Node.js App** → the main application → change **Application URL** from
`pornsexvideo.org` to `afterdark.pornsexvideo.org`. Leave the application root
where it is — the code does not move, only the hostname in front of it.

Then update these, on the **main** application:

| Variable | New value | Why |
|---|---|---|
| `ADS_ORIGIN` | `https://ads.pornsexvideo.org` | §0 — the one that is missing |
| `SITE_ORIGIN` | `https://afterdark.pornsexvideo.org` | Where the site now lives |
| `ADS_EXIT_WAIT` | `5` | Seconds the exit interstitial holds before Continue arms |
| `ADS_EXIT_MODE` | `once` | Gate once per destination per session (see §5) |
| `SUPPORT_URL` | `https://buymeacoffee.com/<your-handle>` | Switches on the coffee button (see §6) |

And on the **ads-only** application (`ads.pornsexvideo.org`):

| Variable | New value | Why |
|---|---|---|
| `SITE_ORIGIN` | `https://afterdark.pornsexvideo.org` | Frames are refused to anyone else |

That last one matters and is easy to miss. The ad frames send
`frame-ancestors 'self' $SITE_ORIGIN`. It currently reads
`https://pornsexvideo.org`, so the moment the site moves to the subdomain, the
browser will refuse to render a single ad frame — the tags would be fine and
every slot would still be empty. Change it in the same sitting as the move.

Restart both applications.

### The session cookie

Readers signed in on the apex will be signed out on the subdomain. That is not
a bug to work around: the cookie is deliberately **host-only** (`cookieOpts` in
`src/auth.js` sets no `domain`), and that is exactly what makes it safe to hand
`allow-same-origin` to ad frames on a neighbouring subdomain. Widening the
cookie to `.pornsexvideo.org` to preserve those sessions would hand every ad
tag on the ads host a session cookie. Let people sign in again.

---

## 4. Put the welcome page on the apex

Four files go into the apex document root, `/home/olenspro/public_html/`:

```
public_html/index.html
public_html/ads/leaderboard.html
public_html/ads/rectangle.html
public_html/ads/mobile.html
```

**If you have SSH** — from the application root, one line:

```bash
cp -r deploy/welcome/. /home/olenspro/public_html/
```

**If you only have cPanel's File Manager** — the same thing by hand:

1. **File Manager** → `/home/olenspro/public_html`.
2. If an old `index.html` is there, rename it `index.html.bak` rather than
   deleting it. It costs nothing and it is the difference between a mistake and
   an outage.
3. **+ Folder** → `ads`.
4. Navigate to the application root → `deploy` → `welcome`. Select
   `index.html` → **Copy** → destination `/home/olenspro/public_html`.
5. Go into `deploy/welcome/ads`, select all three files → **Copy** →
   destination `/home/olenspro/public_html/ads`.

Either way, check it landed before moving on:

```console
$ curl -s https://pornsexvideo.org/ | grep -c 'Enter AfterDark'
1
$ curl -sI https://pornsexvideo.org/ads/rectangle.html | head -1
HTTP/2 200
```

If the second one 404s, the `ads/` folder did not copy and every slot on the
welcome page will silently stay collapsed — which, as in §0, looks exactly like
a page that was designed without adverts.

Two lines at the top of the script block in `index.html` are the whole
configuration:

```js
var DESTINATION = 'https://afterdark.pornsexvideo.org/';
var WAIT_SECONDS = 5;
```

The page is a plain static file that depends on nothing. That is the point of
it: Passenger stops an idle application and restarts it on the next request, so
if the app is down or cold, the apex still answers, still shows the age notice,
and still serves an advert.

**Check `www` too.** `www.pornsexvideo.org` currently serves the app. Point it
at the same document root as the apex, or redirect it there, or it will keep
serving a copy of the site from the old address.

---

## 5. What readers now see

```
pornsexvideo.org
  └─ age gate  →  welcome + advert  →  [Enter AfterDark]
                                          └─ interstitial: advert + 5s wait
                                                └─ [Continue] → afterdark.pornsexvideo.org
```

And on the site itself, every link that leaves it — the directory, wire source
links, links inside posts and comments — goes through the same interstitial:
the destination host in full, two ad slots, a five-second wait, then a Continue
button that opens the destination in a new tab.

Two kinds of link deliberately skip it, marked `data-no-gate`:

- **Sponsored links.** Gating an advert behind an advert costs a paid click and
  shows the reader nothing new.
- **Compliance and safety links** — the RTA label, the child-exploitation
  reporting line, and the age gate's own way out. A countdown and a banner in
  front of somebody trying to report abuse is indefensible whatever it earns.

### How often the same reader meets it

`ADS_EXIT_MODE` decides, and it ships as `once`: once per **destination host**
per session. The first click through to xvideos.com is gated; later clicks to
xvideos.com in that sitting go straight through, and the next visit starts
over. `www.` is ignored, so `www.pornhub.com` and `pornhub.com` count as one
destination rather than two bites at the same reader.

Everyone passing through still sees the advert — `once` drops only the repeats.
What it protects is the person reading one thread and opening six links from
it, and that person is the site's whole premise: someone who comes back to
argue in the comments. `always` bills them thirty seconds for one afternoon,
and the reliable answer to that is an ad blocker, after which they are worth
nothing at all.

Set `ADS_EXIT_MODE=always` to gate every click regardless. `ADS_EXIT_WAIT=0`
keeps the panel but drops the wait; it is clamped at 15 seconds.

Worth watching in the first week: impressions on `exitTop`/`exitBox` against
your outbound click count. If the ratio is far below 1, most clicks are repeats
and `always` is worth trying. If bounce rate climbs, it is not.

---

## 6. Buy me a coffee

`/support` is live and linked from the footer and the navigation drawer. It has
three states and the server picks whichever is configured — no code change to
move between them.

**Now — Buy Me a Coffee.** Create the profile at buymeacoffee.com, then set one
variable on the main app:

```
SUPPORT_URL=https://buymeacoffee.com/<your-handle>
```

The tiers become links to it. No third-party script runs, so the site's
`script-src 'self'` is untouched, and there is nothing to test beyond clicking
the button. Payouts go via Stripe, Payoneer or Wise depending on country.

Substitute any other payment page here and it works identically — a UPI link, a
Razorpay Payment Page, bKash, anything with a URL. The site does not care which.

> **Before committing to Razorpay:** it onboards merchants in **India** (and
> now Malaysia) only, and wants an Indian business registration and an Indian
> bank account. Given this account is hosted on a `-bd-` node, check you can
> actually open one before planning around it. Nothing is wasted if you cannot
> — `SUPPORT_URL` is the mode the site ships in, and it takes any processor.
>
> Also check the processor's own rules on adult-adjacent sites. Payment
> processors quietly setting content policy is a thing the newsroom on this
> site reports on, and it applies to the site itself: read the acceptable-use
> terms before you depend on the revenue.

**Later, if Razorpay is set up:** add both keys and full Checkout switches on
by itself.

```
RAZORPAY_KEY_ID=rzp_live_xxxxxxxx
RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxx
```

There is no third variable to remember — the mode is derived from whether both
keys are present, because a half-configured payment flow that *looks* live is
worse than one that is plainly off. Setting them is also what adds
`checkout.razorpay.com` to the CSP; leave them empty and nothing changes.

The server creates the order, so the amount is fixed here and cannot be edited
in the browser, and it verifies Razorpay's signature before marking anything
paid. Card details never touch this server. Amounts and currency:

```
SUPPORT_CURRENCY=INR
SUPPORT_TIERS=99,299,599
```

Test with `rzp_test_` keys first — the flow is identical and no money moves.

---

## 7. Verify

```bash
# The app answers on the subdomain
curl -sI https://afterdark.pornsexvideo.org/ | head -1

# Ads are pointed at their own origin — this is the one that was broken
curl -s https://afterdark.pornsexvideo.org/api/ads \
  | grep -o '"origin":"[^"]*"'
# want: "origin":"https://ads.pornsexvideo.org"

# Ad frames will render inside the new site
curl -sI https://ads.pornsexvideo.org/ads/top \
  | grep -io 'frame-ancestors[^;]*'
# want: frame-ancestors 'self' https://afterdark.pornsexvideo.org

# The support page knows what it is
curl -s https://afterdark.pornsexvideo.org/api/support \
  | grep -o '"mode":"[^"]*"'

# The welcome page is static and does not need the app
curl -sI https://pornsexvideo.org/ | head -1
curl -s https://pornsexvideo.org/ | grep -c 'Enter AfterDark'
```

Then in a browser, because the part that matters cannot be curled:

1. `https://pornsexvideo.org` → age gate → welcome. **An advert is visible.**
   If the slot is collapsed, the tag did not fill — check the browser console
   inside the frame, not the page.
2. Press **Enter AfterDark** → interstitial with an advert and a counting-down
   button → **Continue** → the site loads.
3. On the site, add `?ads=preview` to any URL. Every slot draws as a labelled
   outline whether or not it filled, which is the only way to check placements
   on inventory that collapses when unsold. `?ads=off` clears it.
4. Click any external link — a directory entry, a wire source. The interstitial
   should appear naming the destination. Continue, come back, and click a link
   to **the same site** again: it should now go straight through. A link to a
   *different* site should still be gated. That is `ADS_EXIT_MODE=once`.
5. Click the child-exploitation reporting link in the footer. It must go
   straight there with **no** interstitial.
6. Open `/support`. With `SUPPORT_URL` set it shows three tiers and a custom
   amount; without it, an honest "not open yet".

---

## Still worth knowing

**Check the host's acceptable-use policy for adult content.** Most shared plans
restrict it, and enforcement is normally account-level suspension rather than
per-domain — so if other domains live on the `olenspro` account, they go down
too. This did not change by moving to a subdomain.
