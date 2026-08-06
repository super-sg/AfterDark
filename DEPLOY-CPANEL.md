# Deploying on cPanel shared hosting

This app was built as a long-lived process with a local SQLite file, which is
why it does not fit serverless platforms. It fits cPanel *if* the plan offers
Node.js — and where it does, a mid-tier shared plan is often more generous than
a free container tier. Check the account first:

| Requirement | cPanel feature | Why it is needed |
|---|---|---|
| Node.js app | `passengerapps`, `lvenodejssel` | Runs the server under Passenger |
| Shell | `ssh` | `npm install` builds two native addons |
| Scheduled jobs | `cron` | Passenger idles the app; cron drives the wire |
| Disk | ~600 MB free | `node_modules` ≈ 250 MB, plus DB and image cache |
| Memory | 1 GB+ | `sharp` is the hungry part |

Read them from the account with a cPanel API token:

```bash
curl -H "Authorization: cpanel USER:TOKEN" \
  "https://HOST:2083/execute/Features/list_features"
curl -H "Authorization: cpanel USER:TOKEN" \
  "https://HOST:2083/execute/ResourceUsage/get_usages"
```

## 1. Get the code onto the account

cPanel → **Git™ Version Control** → Create, clone URL
`https://github.com/super-sg/AfterDark.git`, repository path `~/<app-root>`.
The repo is public, so no deploy key is needed. Pulling later is one click.

## 2. Create the Node.js application

cPanel → **Setup Node.js App** → Create Application:

- **Application root** — `<app-root>` (where the repo was cloned)
- **Application URL** — your domain
- **Application startup file** — `app.js`
- **Node.js version** — 22 LTS

`app.js` is a thin wrapper, not a second server: it pins `CLUSTER=1`, because
Passenger manages processes and `node:cluster` underneath it means two
supervisors fighting over the same sockets, and it turns off the in-process
wire timer in favour of cron (see §5).

Then press **Run NPM Install**, or from the app's virtualenv over SSH:

```bash
source ~/nodevenv/<app-root>/22/bin/activate && cd ~/<app-root>
npm ci --omit=dev
```

Node **22**, not 24: `better-sqlite3` v11 ships no prebuilt binary for Node 24's
ABI, so npm compiles it from source, and that build aborts the process about a
second after boot. On 22 a tested prebuild is downloaded.

## 3. Environment variables

Set these in the Node.js App screen. `SESSION_SECRET` is the one that stops the
app booting if missing — deliberately, since the fallback would be a guessable
cookie-signing key.

| Variable | Value |
|---|---|
| `SESSION_SECRET` | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `NODE_ENV` | `production` |
| `TRUST_PROXY` | `1` — Apache sits in front |
| `CLUSTER` | `1` |
| `DB_PATH` | `/home/<user>/afterdark-data/afterdark.db` |
| `IMAGE_CACHE_DIR` | `/home/<user>/afterdark-data/imgcache` |
| `SHARP_CONCURRENCY` | `1` |
| `ADS_ORIGIN` | `https://ads.<yourdomain>` (see §4) |

Keep `DB_PATH` **outside the application root**. Passenger serves
`<app-root>/public` as the document root, so the database is not web-reachable
either way — but a `git pull` that touches a tracked path should never be able
to land on top of live data.

## 4. The ad subdomain

Ad tags refuse to render without `localStorage`, `localStorage` needs a real
origin, and giving the frames the site's own origin would let ad script call the
API as the signed-in reader. A subdomain is a different origin, which satisfies
the tag and still keeps it out of the site. This is safe here only because the
session cookie is host-only — `cookieOpts` in `src/auth.js` sets no `domain`.

1. **Subdomains** → create `ads.<yourdomain>`.
2. **Setup Node.js App** → second application, root `~/ads-app`, startup file
   `app.js`. Copy `deploy/ads-app.js` there as `app.js` — it requires the main
   installation's server rather than carrying its own `node_modules`, saving
   ~250 MB and guaranteeing both run identical code.
3. Environment: `ADS_ONLY=1`, `AFTERDARK_ROOT=/home/<user>/<app-root>`,
   `SITE_ORIGIN=https://<yourdomain>`, `SESSION_SECRET=<any value>`.

Without `ADS_ORIGIN` the slots stay collapsed and earn nothing, and because
unfilled slots collapse to zero height, that failure is invisible. The server
logs a warning at startup when it is unset.

## 5. Cron

Passenger stops an idle application and restarts it on the next request, so
in-process timers run only while somebody is reading the site — the front page
quietly stops moving and nothing looks broken. Cron owns the schedule instead:

```
0,10,20,30,40,50 * * * *  cd ~/<app-root> && ~/nodevenv/<app-root>/22/bin/node scripts/cron-tick.js >> ~/logs/wire.log 2>&1
```

Use the virtualenv's `node`, not the system one — the native addons are built
against that version. Every run logs a line whether or not anything changed; a
job that logs only on change makes a working wire indistinguishable from a dead
one.

## Before you commit to shared hosting

**Check the host's acceptable-use policy for adult content.** Most shared plans
restrict it, and enforcement is normally account-level suspension rather than
per-domain. If other domains live on the same cPanel account, they go down too.
A host that permits adult material, or a VPS where the account is only this
site, avoids putting unrelated sites at risk.
