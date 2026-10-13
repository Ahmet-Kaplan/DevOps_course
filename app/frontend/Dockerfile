# syntax=docker/dockerfile:1
# =============================================================================
# Bug Squash Arena frontend image (multi-stage build)
#
#   docker build --target dev        .  -> Vite dev server with hot reload (docker-compose.yml)
#   docker build --target build      .  -> intermediate stage: compiled static files in /app/dist
#   docker build --target production .  -> nginx serving those files (what CI pushes to Docker Hub)
#
# Multi-stage = several FROMs in one file. Each stage is its own image; the final
# image contains only what the last stage copies in. Node.js, node_modules and
# the source code never reach production: only ~50 kB of HTML/CSS/JS plus nginx.
#
# Layer caching: Docker reuses a cached layer until one of its inputs changes.
# So we copy package.json + package-lock.json first and install, THEN copy the
# source. Editing a .js file invalidates only the layers after `COPY . .`;
# the slow `npm ci` layer stays cached until the dependencies change.
# =============================================================================


# -----------------------------------------------------------------------------
# Stage "dev": local development (docker compose up)
# -----------------------------------------------------------------------------
FROM node:24.21.0-alpine3.24 AS dev
WORKDIR /app

COPY package.json package-lock.json ./
# npm ci installs exactly what package-lock.json says (reproducible), including
# devDependencies (vite, eslint), which the dev server needs. The cache mount
# keeps npm's download cache between builds without storing it in the image.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

# docker-compose.yml bind-mounts ./app/frontend over /app for hot reload, and an
# anonymous volume on /app/node_modules keeps the Linux (musl) dependencies
# installed above instead of whatever is on the host. This COPY makes the image
# also work on its own, without the bind mount.
COPY . .

EXPOSE 5173
# Exec form (JSON array): vite is PID 1 and receives `docker stop`'s SIGTERM
# directly. Vite installs a SIGTERM handler and shuts down cleanly. (A PID 1 with
# no handler would ignore SIGTERM, and Docker would SIGKILL it after 10 s.)
# docker-compose.yml additionally sets `init: true`, so there tini is PID 1 and
# forwards the signal to vite.
CMD ["node", "node_modules/vite/bin/vite.js"]


# -----------------------------------------------------------------------------
# Stage "build": compile the static site
# -----------------------------------------------------------------------------
# --platform=$BUILDPLATFORM: run this stage natively on the machine doing the
# build, even when producing an arm64 image on an amd64 CI runner. HTML/CSS/JS
# are the same bytes on every CPU architecture, so there is no point compiling
# them under (slow) QEMU emulation. Only the final nginx stage is per-platform.
FROM --platform=$BUILDPLATFORM node:24.21.0-alpine3.24 AS build
WORKDIR /app

COPY package.json package-lock.json ./
# Note: no NODE_ENV=production here. That would make npm skip devDependencies,
# and vite IS a devDependency (it is a build tool, not a runtime dependency).
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

COPY . .

# Version shown in the footer. CI (ci-main.yml) passes the 7-character git short SHA:
#   docker build --build-arg VITE_APP_VERSION=1a2b3c4 ...
# Vite reads VITE_* variables from the environment and inlines them into the
# bundle, so this value is frozen into the JavaScript at build time.
ARG VITE_APP_VERSION=dev
ENV VITE_APP_VERSION=${VITE_APP_VERSION}

RUN npm run build


# -----------------------------------------------------------------------------
# Stage "production" (final): nginx, non-root, static files only
# -----------------------------------------------------------------------------
FROM nginxinc/nginx-unprivileged:1.30.5-alpine3.24 AS production

ARG VITE_APP_VERSION=dev
LABEL org.opencontainers.image.title="bugsquash-frontend" \
      org.opencontainers.image.description="Bug Squash Arena static frontend served by unprivileged nginx" \
      org.opencontainers.image.version="${VITE_APP_VERSION}"

# Our server block replaces the image's default one.
COPY nginx.conf /etc/nginx/conf.d/default.conf

# The site lives in its own directory instead of the image's
# /usr/share/nginx/html, which still contains a placeholder index.html owned by
# root (and we don't want to switch to root just to delete it).
# Files are copied as root:root with mode 644: nginx (uid 101) can read them but
# cannot modify them, even if someone found a way to make it try.
COPY --from=build /app/dist /usr/share/nginx/bugsquash

# The base image already runs as the unprivileged nginx user; stated again so
# nobody has to look it up. Numeric, so tools can verify "non-root" without
# reading /etc/passwd inside the image.
USER 101

EXPOSE 8080

# Docker marks the container healthy/unhealthy based on this command.
# `docker compose up --wait` and `depends_on: condition: service_healthy` use it.
# 127.0.0.1 (not "localhost") because localhost may resolve to ::1, and we only
# listen on IPv4. Exec form, no shell needed: busybox wget already exits 1 on
# any failure, which is exactly what HEALTHCHECK expects for "unhealthy".
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
    CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]

# Inherited from the base image, shown here because it is a nice PID 1 lesson:
#   STOPSIGNAL SIGQUIT  -> `docker stop` sends SIGQUIT, nginx's "graceful shutdown"
#                          (finish in-flight requests, then exit). SIGTERM would
#                          make nginx drop connections immediately.
#   CMD ["nginx", "-g", "daemon off;"] -> nginx stays in the foreground as PID 1.
#                          A daemonizing nginx would fork and exit, and Docker
#                          would think the container had stopped.
