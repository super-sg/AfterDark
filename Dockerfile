# AfterDark runs as a long-lived process with a local SQLite file and a disk
# image cache. That is a deliberate design — it is what makes 1000 concurrent
# readers work on one small box — and it is also why it cannot run on a
# serverless platform. This image targets anything that runs a container with a
# persistent volume: Fly, Railway, Render, or a plain VPS.

# ---- build ------------------------------------------------------------------
# better-sqlite3 and sharp are native addons. They need a toolchain to compile,
# which has no business being in the image that faces the internet.
#
# Pinned to 22 (LTS) deliberately -- do not bump this to 24 without checking.
# better-sqlite3 v11 publishes no prebuilt binary for Node 24's ABI, so on 24 it
# silently falls back to compiling from source, and that build has a bug in
# ~Statement(): it calls RemoveEnvironmentCleanupHook after the environment is
# gone and aborts the process a second after boot. The build succeeds, the image
# is fine, and the container dies on startup -- which reads like a config
# problem and is not one. On 22 a tested prebuild is downloaded instead.
FROM node:22-bookworm-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime ----------------------------------------------------------------
# Must match the build stage exactly: a native addon is compiled against one
# Node ABI and will not load on another.
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY server.js ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

# The database and the image cache live on a mounted volume. Without one, both
# are lost on every redeploy — the app will still boot, which is exactly the
# failure that is easy to miss until the first restart.
# Overridden by the host. /data is the durable choice; a free tier without a
# volume points these at /tmp instead and reseeds on each cold start.
ENV DB_PATH=/data/afterdark.db
ENV IMAGE_CACHE_DIR=/data/imgcache
RUN mkdir -p /data && chown -R node:node /data

# Drop privileges. Nothing here needs root.
USER node

EXPOSE 8080
ENV PORT=8080

# The app has no /health route, so check the shell — it is served by the same
# Express instance and proves the worker is answering.
HEALTHCHECK --interval=30s --timeout=4s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
