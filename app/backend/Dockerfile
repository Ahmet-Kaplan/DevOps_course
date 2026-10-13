# syntax=docker/dockerfile:1
# ^ Use the latest stable Dockerfile syntax (needed for RUN --mount below).
#
# Bug Squash Arena API — multi-stage build.
#
#   docker build --target dev        -t bugsquash-backend:dev .   # local hot reload
#   docker build --target production -t bugsquash-backend .       # what we ship
#
# MULTI-STAGE: each FROM starts a fresh stage. Only the LAST stage you build
# becomes the image; earlier stages are scaffolding whose leftovers (npm
# cache, devDependencies, test files) never reach production.
#
# LAYERS & CACHING: every instruction creates a layer, cached by its inputs.
# When one layer changes, all layers after it are rebuilt. So we order from
# "rarely changes" to "changes on every commit":
#     base image -> package*.json + npm ci -> source code
# Editing src/ then reuses the cached `npm ci` layer: rebuilds take seconds.

# -----------------------------------------------------------------------------
# Stage "base": shared starting point for all other stages.
# -----------------------------------------------------------------------------
# Alpine is a ~5 MB distro (musl libc + busybox): smaller image, smaller attack
# surface. We pin the Node major version (24 = current LTS line).
FROM node:24-alpine AS base
WORKDIR /app
# Containers are ephemeral: silence npm's "new version available" banner,
# which would otherwise clutter `docker compose logs` on every start.
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

# -----------------------------------------------------------------------------
# Stage "dev": used by docker-compose.yml for local development.
# -----------------------------------------------------------------------------
FROM base AS dev
ENV NODE_ENV=development

# Copy ONLY the dependency manifests first (see LAYERS & CACHING above).
COPY package.json package-lock.json ./

# `npm ci` installs exactly what package-lock.json says (reproducible), and
# includes devDependencies (eslint) so `npm run lint` works in the container.
# The cache mount keeps npm's download cache on the build host between builds
# without storing it in an image layer.
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# In compose, ./app/backend/src is bind-mounted over /app/src, so edits on
# your machine are seen live by `node --watch`. This COPY makes the image
# also work on its own (docker run without a bind mount).
COPY . .

# Drop root privileges. The official image ships a "node" user; we reference
# it by numeric uid:gid (1000 = node) so tools that check "is this non-root?"
# without reading /etc/passwd (hadolint, Kubernetes runAsNonRoot) can verify it.
USER 1000:1000
EXPOSE 3000

# npm run dev = node --watch src/server.js (restarts on file changes).
# Note: here npm, not node, is PID 1; fine for dev (docker-compose.yml also
# sets `init: true`, putting tini at PID 1 to forward signals), but production
# runs node directly (see the production stage and src/server.js for why).
CMD ["npm", "run", "dev"]

# -----------------------------------------------------------------------------
# Stage "prod-deps": production dependencies only.
# -----------------------------------------------------------------------------
FROM base AS prod-deps
COPY package.json package-lock.json ./
# --omit=dev skips eslint & friends: fewer packages = smaller image and fewer
# CVEs for vulnerability scanners to flag.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

# -----------------------------------------------------------------------------
# Stage "production": the image CI pushes to Docker Hub. Keep it LAST so a
# plain `docker build .` (no --target) produces it.
# -----------------------------------------------------------------------------
FROM base AS production
ENV NODE_ENV=production

# Take the already-installed node_modules from the prod-deps stage, then our
# code. We copy only what runs: no tests, no lint config, no lockfile.
# No --chown: files stay owned by root, so the "node" user can read but not
# modify them — even a compromised process cannot rewrite its own code
# (pairs well with `read_only: true` in docker-compose.prod.yml).
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# Least privilege: never run the app as root inside the container.
# 1000:1000 is the image's built-in "node" user (numeric, see dev stage).
USER 1000:1000
EXPOSE 3000

# Docker runs this probe periodically; the container's status becomes
# "healthy"/"unhealthy" (see `docker ps`). Compose's `depends_on:
# condition: service_healthy` and `up --wait` rely on it.
# - busybox wget ships with Alpine (no extra package) and exits non-zero on
#   HTTP errors such as our 503 "db down".
# - The probe runs INSIDE the container, in its cgroup: its memory counts
#   against the container's limit. A ~1 MB wget is much cheaper than starting
#   a second ~40 MB node process every 10 seconds.
# - Exec form (JSON array) avoids spawning a shell, so the port is literal:
#   if you change PORT, override `healthcheck:` in compose as well.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
    CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:3000/api/health"]

# Build-time version stamp (CI passes the git short SHA). Declared at the very
# end on purpose: a build ARG invalidates the cache of the instructions after
# it, so placing it last keeps every layer above cacheable across versions.
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}

# EXEC form (JSON array): node runs directly as PID 1 and receives SIGTERM
# from `docker stop`. Shell form (`CMD node src/server.js`) would make
# /bin/sh PID 1, and sh does not forward signals.
CMD ["node", "src/server.js"]
