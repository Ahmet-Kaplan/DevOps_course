# Zero-to-Hero DevOps Workshop: Bug Squash Arena

<!-- Forked this repository? Replace "Mohammed-Alhuraibi/DevOps_course" in the three badge URLs below. -->
[![CI (dev)](https://github.com/Mohammed-Alhuraibi/DevOps_course/actions/workflows/ci-dev.yml/badge.svg?branch=dev)](https://github.com/Mohammed-Alhuraibi/DevOps_course/actions/workflows/ci-dev.yml)
[![CI (test)](https://github.com/Mohammed-Alhuraibi/DevOps_course/actions/workflows/ci-test.yml/badge.svg?branch=test)](https://github.com/Mohammed-Alhuraibi/DevOps_course/actions/workflows/ci-test.yml)
[![CD (main)](https://github.com/Mohammed-Alhuraibi/DevOps_course/actions/workflows/ci-main.yml/badge.svg?branch=main)](https://github.com/Mohammed-Alhuraibi/DevOps_course/actions/workflows/ci-main.yml)

![Node.js 24](https://img.shields.io/badge/Node.js-24-5FA04E?logo=nodedotjs&logoColor=white)
![Express 5](https://img.shields.io/badge/Express-5-000000?logo=express&logoColor=white)
![PostgreSQL 17](https://img.shields.io/badge/PostgreSQL-17-4169E1?logo=postgresql&logoColor=white)
![Vite 8](https://img.shields.io/badge/Vite-8-646CFF?logo=vite&logoColor=white)
![Docker Compose](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)
![nginx](https://img.shields.io/badge/nginx-reverse%20proxy-009639?logo=nginx&logoColor=white)
![GitHub Actions](https://img.shields.io/badge/GitHub%20Actions-CI%2FCD-2088FF?logo=githubactions&logoColor=white)
![Hetzner Cloud](https://img.shields.io/badge/Hetzner-Debian%2013-D50C2D?logo=hetzner&logoColor=white)
![Cloudflare DNS](https://img.shields.io/badge/Cloudflare-DNS-F38020?logo=cloudflare&logoColor=white)
![Let's Encrypt](https://img.shields.io/badge/Let%27s%20Encrypt-TLS-003A70?logo=letsencrypt&logoColor=white)

**Bug Squash Arena** is a small, silly DevOps-themed clicker game. You sign up, log in, and get
10-second rounds in which a bug hops around a circuit board; every click squashes it for +1 point.
Your scores are saved, the dashboard gives you a rank title ("Intern", "Works on My Machine",
"10x Engineer", and so on), and a public top-10 leaderboard shows the best players. The game is
just the excuse. The real subject of this workshop is the **path that code travels** from your
laptop to a real HTTPS website. You run the stack locally with Docker Compose and promote changes
through `dev -> test -> main` branches. GitHub Actions lints, tests, builds and pushes multi-arch
images to Docker Hub, and you deploy them to a hardened Debian server on Hetzner Cloud behind
nginx, Let's Encrypt and Cloudflare DNS at **https://devops.gulfheight.com**. There is
deliberately **no Kubernetes**: one server and one Compose file, so every moving part stays visible.

---

## Table of contents

- [What you will learn](#what-you-will-learn)
- [Tech stack](#tech-stack)
- [Architecture](#architecture)
- [Repository structure](#repository-structure)
- [Student guide](#student-guide)
  - [Part 0: Prerequisites](#part-0-prerequisites)
  - [Part 1: Theory first](#part-1-theory-first)
  - [Part 2: Run it locally](#part-2-run-it-locally)
  - [Part 3: Git branching strategy](#part-3-git-branching-strategy)
  - [Part 4: GitHub Actions and secrets](#part-4-github-actions-and-secrets)
  - [Part 5: Provision the Hetzner server](#part-5-provision-the-hetzner-server)
  - [Part 6: Cloudflare DNS](#part-6-cloudflare-dns)
  - [Part 7: HTTPS with Let's Encrypt](#part-7-https-with-lets-encrypt)
  - [Part 8: Deploy, pin and roll back](#part-8-deploy-pin-and-roll-back)
  - [Part 9: Verify the deployment](#part-9-verify-the-deployment)
  - [Part 10: Troubleshooting](#part-10-troubleshooting)
- [API reference](#api-reference)
- [Environment variables](#environment-variables)
- [Make it your own: exercises and stretch goals](#make-it-your-own-exercises-and-stretch-goals)

---

## What you will learn

- **What a container really is.** It is a Linux process isolated by namespaces and limited by
  cgroups v2, running on an overlay filesystem built from image layers. You will also learn why
  PID 1 must handle `SIGTERM`.
- **Production-grade Dockerfiles**: multi-stage builds, layer-cache-friendly ordering, non-root
  users, exec-form `CMD`, `HEALTHCHECK`s, and build arguments that stamp a version into the image.
- **Docker Compose in two roles.** The dev stack uses bind mounts, hot reload and anonymous
  volumes. The production stack pulls images and uses loopback-only ports, resource limits, an
  internal network, read-only root filesystems and log rotation.
- **Twelve-Factor configuration**: everything is configured through environment variables,
  secrets never enter Git, and the stack fails fast when a required secret is missing.
- **A branching strategy** (`dev -> test -> main`) with pull requests, branch protection and
  promotion between environments.
- **CI/CD with GitHub Actions**:
  - linting, unit tests, `hadolint`, `shellcheck` and Compose validation;
  - integration tests against the *real* production Compose file;
  - multi-arch builds (amd64 and arm64) with Buildx and QEMU;
  - the GitHub Actions layer cache;
  - least-privilege tokens and concurrency groups;
  - an optional SSH deploy job.
- **Release engineering**: immutable `sha-<commit>` image tags, one-command rollbacks, smoke
  tests, and a footer that shows *which commit is live*.
- **Linux server administration** on Hetzner Cloud:
  - SSH keys and a non-root deploy user;
  - `ufw`, and why Docker-published ports bypass it;
  - unattended upgrades;
  - the differences between Debian 13 and Debian 12.
- **Reverse proxies**: TLS termination on the host nginx, `X-Forwarded-*` headers, Express
  `trust proxy`, keepalive upstreams, and Docker's embedded DNS for container-to-container traffic.
- **DNS and TLS**: Cloudflare records (gray cloud vs orange cloud, SSL modes), Let's Encrypt
  HTTP-01 validation, and automatic renewal.

## Tech stack

| Layer | Technology | Where |
|-------|------------|-------|
| Frontend | Vite 8 multi-page app, vanilla JavaScript modules (no framework), ESLint 10 | [`app/frontend/`](app/frontend/) |
| Frontend runtime | `nginxinc/nginx-unprivileged:1.27-alpine` (non-root, port 8080) | [`app/frontend/Dockerfile`](app/frontend/Dockerfile), [`app/frontend/nginx.conf`](app/frontend/nginx.conf) |
| Backend | Node.js 24 (`node:24-alpine`), Express 5, `pg`, `bcryptjs`, `jsonwebtoken`, `helmet`, `express-rate-limit`, ESLint 9 | [`app/backend/`](app/backend/) |
| Database | PostgreSQL 17 (`postgres:17-alpine`), schema created idempotently by the backend at startup | [`app/backend/src/db.js`](app/backend/src/db.js) |
| Local orchestration | Docker Compose (project `bugsquash-dev`) | [`docker-compose.yml`](docker-compose.yml) |
| Production orchestration | Docker Compose (project `bugsquash`) | [`docker-compose.prod.yml`](docker-compose.prod.yml) |
| Tests | `node:test` unit tests (fake DB) and zero-dependency integration tests using `fetch` | [`app/backend/test/`](app/backend/test/), [`tests/integration/`](tests/integration/) |
| CI/CD | GitHub Actions, Docker Buildx + QEMU, Docker Hub | [`.github/workflows/`](.github/workflows/) |
| Server | Hetzner Cloud, Debian 13 "trixie" (Debian 12 also works), x86 or Ampere Arm | [`deploy/hetzner-server-setup.md`](deploy/hetzner-server-setup.md) |
| Edge | Host nginx (apt package) + Let's Encrypt (certbot) | [`deploy/nginx/`](deploy/nginx/), [`deploy/letsencrypt-setup.md`](deploy/letsencrypt-setup.md) |
| DNS | Cloudflare, `devops.gulfheight.com` A record | [`deploy/cloudflare-dns-guide.md`](deploy/cloudflare-dns-guide.md) |

---

## Architecture

### The complete flow: from laptop to browser

```mermaid
flowchart TB
    subgraph LAPTOP["(1) Laptop: docker compose"]
        direction LR
        VITE["Vite dev server :5173<br/>hot reload"] --> API_DEV["backend :3000<br/>node --watch"] --> PG_DEV[("postgres :5432")]
    end

    subgraph GITHUB["(2) GitHub repository"]
        direction LR
        DEV_BR["branch dev"] -->|"pull request"| TEST_BR["branch test"] -->|"pull request"| MAIN_BR["branch main"]
    end

    subgraph ACTIONS["(3) GitHub Actions"]
        direction LR
        CI_DEV["ci-dev.yml<br/>lint + unit tests<br/>hadolint, shellcheck<br/>compose config"]
        CI_TEST["ci-test.yml<br/>build production images<br/>run docker-compose.prod.yml<br/>integration tests"]
        CI_MAIN["ci-main.yml<br/>build linux/amd64 + linux/arm64<br/>push :latest + :sha-xxxxxxx"]
    end

    HUB[("(4) Docker Hub<br/>user/bugsquash-backend<br/>user/bugsquash-frontend")]

    subgraph HETZNER["(5) Hetzner server: Debian 13"]
        DEPLOY["deploy/deploy.sh<br/>compose pull, up --wait, smoke tests"]
        NGINX["host nginx :80 and :443<br/>Let's Encrypt TLS"]
        FE["frontend container<br/>nginx-unprivileged<br/>127.0.0.1:8080"]
        BE["backend container<br/>Express 5<br/>127.0.0.1:3000"]
        DB[("postgres 17<br/>internal network: data")]
    end

    CF["(6) Cloudflare DNS<br/>devops.gulfheight.com A record"]
    USER(["(7) User's browser"])

    LAPTOP -->|"git push"| DEV_BR
    DEV_BR -.->|"push / PR"| CI_DEV
    TEST_BR -.->|"push / PR"| CI_TEST
    MAIN_BR -.->|"push"| CI_MAIN
    CI_MAIN -->|"docker push"| HUB
    CI_MAIN -.->|"optional ssh deploy job"| DEPLOY
    HUB -->|"docker compose pull"| DEPLOY
    DEPLOY --> FE & BE & DB
    USER -->|"a. DNS lookup"| CF
    USER -->|"b. HTTPS :443"| NGINX
    NGINX -->|"/"| FE
    NGINX -->|"/api/"| BE
    BE --> DB
```

The same diagram in plain ASCII, for terminals and `less README.md`:

```
 (1) LAPTOP            docker compose up --build             (project "bugsquash-dev")
                       vite :5173  -->  backend :3000  -->  postgres :5432
                             |
                             | git push
                             v
 (2) GITHUB            dev  ----PR---->  test  ----PR---->  main
                        |                 |                  |
                        | push / PR       | push / PR        | push
                        v                 v                  v
 (3) GITHUB ACTIONS    ci-dev.yml        ci-test.yml        ci-main.yml
                       lint, unit        build production   build amd64 + arm64,
                       tests, hadolint,  images, run the    push :latest and
                       shellcheck,       real compose.prod, :sha-xxxxxxx
                       compose config    integration tests  (optional ssh deploy)
                                                             |
                                                             | docker push
                                                             v
 (4) DOCKER HUB        <user>/bugsquash-backend       <user>/bugsquash-frontend
                                                             |
                                                             | docker compose pull + up --wait
                                                             v (deploy/deploy.sh)
 (5) HETZNER SERVER   +------------------------------------------------------------------+
     Debian 13        | ufw: 22, 80, 443 only                                            |
     /opt/devops-     | host nginx  :80  --> 301 to https (except /.well-known/acme-...) |
       workshop       |             :443 --> TLS (Let's Encrypt cert)                    |
                      |               |-- /api/ --> 127.0.0.1:3000 [backend]             |
                      |               '-- /     --> 127.0.0.1:8080 [frontend]            |
                      | network "edge":            frontend, backend                     |
                      | network "data" (internal): backend --> [db] postgres :5432       |
                      +------------------------------------------------------------------+
                                     ^
                                     | b) HTTPS :443 to that IP
                                     |
 (7) USER'S BROWSER  ----------------+
       |
       | a) "What is the IP of devops.gulfheight.com?"
       v
 (6) CLOUDFLARE DNS    A record  devops.gulfheight.com -> <server IPv4>   (gray cloud)
```

### The runtime request path (production)

```mermaid
flowchart LR
    B(["Browser"]) -->|"(1) resolve devops.gulfheight.com"| CF["Cloudflare DNS"]
    CF -.->|"orange cloud only:<br/>proxies the HTTPS traffic"| N
    B -->|"(2) HTTPS :443<br/>(gray cloud: direct)"| N["host nginx<br/>TLS termination"]
    N -->|"location /api/<br/>127.0.0.1:3000"| BE["backend<br/>Express API"]
    N -->|"location /<br/>127.0.0.1:8080"| FE["frontend<br/>nginx-unprivileged"]
    FE -.->|"own /api/ proxy, backend:3000<br/>via Docker DNS (CI + smoke tests)"| BE
    BE -->|"db:5432<br/>network data (internal)"| DB[("PostgreSQL")]
```

A few facts that make this design work:

- Containers publish ports on **127.0.0.1 only**. Docker writes its own NAT rules for published
  ports, so `ufw` would never see that traffic. Binding to loopback makes the host nginx the only
  way in. The database is not published at all.
- The `data` network is `internal: true`. Only the backend is attached to both networks, so the
  frontend container cannot reach Postgres, and Postgres cannot reach the internet.
- The host nginx sends `/api/` **straight to the backend**, which saves a hop. The frontend
  container *also* proxies `/api/` to `backend:3000` through Docker's embedded DNS
  (`resolver 127.0.0.11`). CI uses that path to test the whole stack through one port, `:8080`.

### Environments at a glance

|  | Local dev | CI (`ci-test.yml`) | Production |
|--|-----------|--------------------|------------|
| Compose file | `docker-compose.yml` | `docker-compose.prod.yml` | `docker-compose.prod.yml` |
| Project name | `bugsquash-dev` | `bugsquash` | `bugsquash` |
| Images | built locally (Dockerfile `dev` targets) | built in the job (`production` targets), tagged `local/bugsquash-*:ci` | pulled from Docker Hub: `<user>/bugsquash-*:<tag>` |
| Env file | `.env` (optional) | `.env.ci` (throwaway, random secrets) | `.env.prod` (`chmod 600`) |
| Source code | bind-mounted, hot reload | baked into the image | baked into the image |
| Entry URL | http://localhost:5173 | http://localhost:8080 | https://devops.gulfheight.com |
| Postgres port | `127.0.0.1:5432` | not published | not published |

---

## Repository structure

```
.
├── README.md                          you are here
├── .env.example                       local dev variables (optional: cp .env.example .env)
├── .env.prod.example                  production template (cp to .env.prod on the server)
├── .gitignore                         keeps node_modules, dist/ and real .env files out of Git
├── docker-compose.yml                 LOCAL DEV: builds "dev" targets, bind mounts, hot reload
├── docker-compose.prod.yml            PRODUCTION: pulls images, loopback ports, limits, 2 networks
├── .github/workflows/
│   ├── ci-dev.yml                     dev:  lint, unit tests, hadolint, shellcheck, compose config
│   ├── ci-test.yml                    test: build prod images, run prod compose, integration tests
│   └── ci-main.yml                    main: multi-arch build + push to Docker Hub, optional deploy
├── app/
│   ├── backend/                       Express 5 REST API (Node 24, CommonJS)
│   │   ├── Dockerfile                 multi-stage: base -> dev | prod-deps -> production
│   │   ├── package.json, package-lock.json, eslint.config.js, .dockerignore
│   │   ├── src/server.js              entry point: migrate DB, listen, graceful SIGTERM shutdown
│   │   ├── src/app.js                 createApp() factory: helmet, trust proxy, routes, errors
│   │   ├── src/config.js              reads and validates env vars (fails fast on bad config)
│   │   ├── src/db.js                  pg pool, schema migration with retry loop, all SQL
│   │   ├── src/validation.js          username / password / score rules (MAX_SCORE = 200)
│   │   ├── src/middleware/auth.js     issue, verify and clear the JWT cookie
│   │   ├── src/routes/                auth.js, scores.js, health.js
│   │   └── test/                      node:test unit tests with a fake DB (no Postgres needed)
│   └── frontend/                      Vite multi-page app, vanilla JS modules
│       ├── Dockerfile                 multi-stage: dev (vite :5173) | build -> production (nginx :8080)
│       ├── nginx.conf                 static files, /healthz, /api/ proxy, caching, CSP
│       ├── vite.config.js             dev server :5173, /api proxy, 5 HTML entry points
│       ├── package.json, package-lock.json, eslint.config.js, .dockerignore
│       ├── index.html                 landing page: practice board + public leaderboard
│       ├── login.html, signup.html    auth forms with inline errors
│       ├── dashboard.html             protected: game, stats, rank, recent games, leaderboard
│       ├── 404.html                   "This page escaped." (served by nginx error_page)
│       ├── src/js/                    one module per page + api.js, game.js, ranks.js, layout.js ...
│       ├── src/styles/                tokens, base, layout, components, game, pages (CSS)
│       └── public/                    favicon.svg, swatter.svg (copied as-is)
├── tests/integration/api.test.mjs     black-box API tests: node:test + fetch, zero dependencies
├── deploy/
│   ├── deploy.sh                      on the server: validate, pull, up --wait, smoke test, prune
│   ├── hetzner-server-setup.md        guide 1: server, SSH, ufw, Docker, nginx, first deploy
│   ├── cloudflare-dns-guide.md        guide 2: A record, gray vs orange cloud, SSL modes
│   ├── letsencrypt-setup.md           guide 3: certbot, bootstrap -> production config, renewal
│   └── nginx/
│       ├── bootstrap/devops.gulfheight.com.http-only.conf   HTTP-only, used to get the first cert
│       └── conf.d/devops.gulfheight.com.conf                production host nginx: TLS, HSTS, proxy
└── docs/containers-deep-dive.md       theory: namespaces, cgroups v2, overlayfs, VMs vs containers
```

Every config file is commented heavily on purpose. Read the comments, because they explain *why*
each line is there.

---

## Student guide

Work through the parts in order. Parts 0 to 4 need only a laptop and free accounts. Parts 5 to 9
need a server and a domain.

### Part 0: Prerequisites

**On your laptop**

| Tool | Version | Check | Notes |
|------|---------|-------|-------|
| Git | any recent | `git --version` | |
| Docker | Engine 24+ with the Compose v2 plugin, or Docker Desktop | `docker compose version` | Windows: use WSL 2 and keep the repo *inside* the WSL filesystem, because bind mounts from `C:\` are slow |
| Node.js | 24 (optional) | `node --version` | Only needed to run lint, unit tests or integration tests *outside* containers. The frontend toolchain needs Node 20.19+, 22.13+ or 24 |
| An SSH key | ed25519 | `ls ~/.ssh/id_ed25519.pub` | Created in Part 5 if you don't have one |

**Accounts**

| Account | Cost | Used for |
|---------|------|----------|
| GitHub | free | repository, pull requests, Actions |
| Docker Hub | free | image registry (2 public repositories) |
| Hetzner Cloud | a few euros per month, billed hourly | the production server (Parts 5 to 9) |
| Cloudflare + a domain | free plan | DNS. The course uses `gulfheight.com`; to use your own domain, see [the exercises](#make-it-your-own-exercises-and-stretch-goals) |

**Skills**: basic terminal use (`cd`, `ls`, editing a file) and basic Git (`clone`, `commit`, `push`).

### Part 1: Theory first

Read **[`docs/containers-deep-dive.md`](docs/containers-deep-dive.md)** before you type
`docker compose up`. It explains what a container is from first principles, and you can prove each
claim on a terminal:

| Chapter | Why it matters for this repo |
|---------|------------------------------|
| 1. Containers vs Docker | Docker is a toolchain; the isolation itself comes from the kernel |
| 2. Namespaces | why three containers can all listen on "their" port without clashing (NET), and why your app is PID 1 (PID) |
| 3. cgroups v2 | what `deploy.resources.limits` in `docker-compose.prod.yml` really does (and the OOM killer) |
| 4. Overlay filesystem and layers | why the Dockerfiles copy `package*.json` before the source code |
| 5. VMs vs containers | why we run containers *inside* a Hetzner VM |
| 6. Proof: the shared kernel | `uname -r` inside Alpine and Debian containers prints the host's kernel |
| 7. [How this repo uses these concepts](docs/containers-deep-dive.md#7-how-this-repo-uses-these-concepts) | maps every production setting to the kernel feature behind it |
| 8. Review questions | 14 quiz questions with hidden answers. Use them to test yourself |

> [!TIP]
> Run the experiments on a Linux machine, or later on your Hetzner server. Docker Desktop on
> macOS and Windows runs containers inside a hidden VM, so some outputs differ. Chapter 6.6
> explains the differences.

### Part 2: Run it locally

#### 2.1 Start the stack

```bash
git clone https://github.com/<your-account>/<your-repo>.git
cd <your-repo>
docker compose up --build
```

No `.env` file is needed, because every variable in `docker-compose.yml` has a safe development
default. The first build takes a few minutes, and later starts take seconds thanks to layer caching.
When the logs settle, open **http://localhost:5173**, sign up and squash some bugs.

| Service | Container | Published on | What it is |
|---------|-----------|--------------|------------|
| `frontend` | `bugsquash-dev-frontend-1` | http://localhost:5173 | Vite dev server; proxies `/api` to `http://backend:3000` |
| `backend` | `bugsquash-dev-backend-1` | http://localhost:3000 | Express API run by `node --watch` |
| `db` | `bugsquash-dev-db-1` | `localhost:5432` | PostgreSQL 17, data in the named volume `bugsquash-dev_pgdata` |

All three are bound to `127.0.0.1`, so other devices on your Wi-Fi cannot reach them. The browser
only ever talks to `:5173`. Because the page and the API share that origin, the login cookie
simply works and no CORS configuration is needed.

```bash
curl -s http://localhost:3000/api/health; echo
# {"status":"ok","db":"up","version":"dev","uptime":12}
```

To override a default, copy the template first: `cp .env.example .env` (the `.env` file is
git-ignored). For example, set `POSTGRES_HOST_PORT=5433` if you already run Postgres on your laptop.

#### 2.2 Hot reload

- **Backend:** `./app/backend/src` is bind-mounted over `/app/src`. Edit a file, for example the
  anti-cheat message in `app/backend/src/validation.js`, and `node --watch` restarts the server
  within a second. Watch it happen with `docker compose logs -f backend`.
- **Frontend:** the whole `./app/frontend` folder is bind-mounted. Edit
  `app/frontend/src/js/ranks.js` (rank titles) or a CSS file, and the browser updates instantly.
  `/app/node_modules` is masked by an *anonymous volume*, so the Linux `node_modules` from the
  image are never hidden or overwritten by your host's files.
- **macOS / Windows:** if edits are not picked up, start with polling:
  `VITE_USE_POLLING=true docker compose up`, or set `VITE_USE_POLLING=true` in `.env`.
- **Changed `package.json`?** Rebuild, and recreate the anonymous volume as well:
  `docker compose up --build --renew-anon-volumes`.

#### 2.3 Look inside the database

```bash
docker compose exec db psql -U bugsquash bugsquash
```

```sql
\dt                                            -- list tables: users, scores
\d users                                       -- columns + the unique index on LOWER(username)
SELECT id, username, created_at FROM users ORDER BY id;
SELECT u.username, MAX(s.score) AS best, COUNT(*) AS games
  FROM scores s JOIN users u ON u.id = s.user_id
 GROUP BY u.username ORDER BY best DESC;
\q
```

GUI clients (DBeaver, pgAdmin) can connect to
`postgresql://bugsquash:bugsquash-dev-password@localhost:5432/bugsquash`.

#### 2.4 Lint and unit tests

These are the same checks `ci-dev.yml` runs:

```bash
docker compose exec backend  npm run lint
docker compose exec backend  npm test        # node:test, fake DB, no Postgres needed
docker compose exec frontend npm run lint
```

> [!NOTE]
> Only `src/` of the backend is bind-mounted. The `test/` folder is copied into the image at
> build time, so after you edit a test, rebuild first with `docker compose up --build -d backend`.
> You can also run the tests on the host with Node 24:
> `cd app/backend && npm ci && npm test` (or `cd app/frontend && npm ci && npm run build`).
> On Linux, once the dev stack has run, `app/frontend/node_modules` exists as an *empty, root-owned*
> folder (Docker's mount point for the anonymous volume) and the host `npm ci` fails with `EACCES`.
> Remove it first with `rmdir app/frontend/node_modules`; no `sudo` is needed because it is empty.

#### 2.5 Integration tests

[`tests/integration/api.test.mjs`](tests/integration/api.test.mjs) is a black-box test of the
running system. It signs up a unique user, logs in, posts scores, checks the anti-cheat rule and
reads the leaderboard. It has zero npm dependencies (`node:test` plus the built-in `fetch`).

```bash
# against the dev stack (needs Node 18+ on the host)
BASE_URL=http://localhost:5173 node --test tests/integration/api.test.mjs

# straight against the API, without any frontend in front of it:
# API_ONLY=1 skips the one test that expects the HTML landing page
API_ONLY=1 BASE_URL=http://localhost:3000 node --test tests/integration/api.test.mjs

# no Node on the host? Linux only: share the host's network namespace with a throwaway container
docker run --rm --network host -v "$PWD/tests:/tests:ro" -e BASE_URL=http://localhost:5173 \
  node:24-alpine node --test /tests/integration/api.test.mjs
```

Each run makes 5 requests to the rate-limited auth endpoints (the limit is 30 per 15 minutes per
IP). If you hit `429`, wait or run `docker compose restart backend`, which resets the counter
because it lives in process memory.

> [!WARNING]
> Never point the integration tests at production. Each run leaves a test player called
> `it_<random>` with a score of 200 on the public leaderboard.

#### 2.6 Rehearse the production stack locally (optional)

This is exactly what `ci-test.yml` does. Stop the dev stack first, because both stacks use
port 3000:

```bash
docker compose down

docker build --target production -t local/bugsquash-backend:ci  app/backend
docker build --target production -t local/bugsquash-frontend:ci app/frontend

cat > .env.ci <<EOF
DOCKER_HUB_USERNAME=local
IMAGE_TAG=ci
POSTGRES_PASSWORD=$(openssl rand -hex 32)
JWT_SECRET=$(openssl rand -hex 32)
COOKIE_SECURE=false
EOF

docker compose -f docker-compose.prod.yml --env-file .env.ci up -d --wait
BASE_URL=http://localhost:8080 node --test tests/integration/api.test.mjs
# open http://localhost:8080 - this is the nginx-unprivileged production image
docker compose -f docker-compose.prod.yml --env-file .env.ci down -v
rm .env.ci
```

`COOKIE_SECURE=false` lets a browser log in over plain `http://localhost:8080`. `deploy.sh` also
has a rehearsal mode that uses your local images instead of pulling: `SKIP_PULL=1 ./deploy/deploy.sh ci`.
Set it up as described in the header of [`deploy/deploy.sh`](deploy/deploy.sh).

#### 2.7 Useful Docker commands

| Command | What it shows / does |
|---------|----------------------|
| `docker compose ps` | services, state, **health**, ports |
| `docker compose logs -f backend` | follow one service's stdout/stderr |
| `docker compose exec backend sh` | shell inside the container (Alpine has `sh`, not `bash`) |
| `docker compose exec backend ps` | processes in the container's PID namespace: PID 1 is `docker-init` (tini) because of `init: true` |
| `docker compose restart backend` | `SIGTERM` -> graceful shutdown -> start again |
| `docker compose up --build` | rebuild images after a Dockerfile or `package.json` change |
| `docker compose down` | stop and remove containers; **keeps** the database volume |
| `docker compose down -v` | ...and **deletes** the database volume (fresh start) |
| `docker stats` | live CPU and memory per container (read from cgroups) |
| `docker image ls` / `docker history <image>` | images and the layers they are made of |
| `docker inspect bugsquash-dev-backend-1` | full container config: mounts, networks, env, health |
| `docker network inspect bugsquash-dev_default` | which containers share the bridge network |
| `docker volume ls` / `docker system df` | volumes; disk used by images, containers, volumes |

### Part 3: Git branching strategy

Each branch is an environment, and every branch has its own quality gate:

| Branch | Purpose | Workflow | Runs on |
|--------|---------|----------|---------|
| `dev` | integration of day-to-day work | **CI (dev)** `ci-dev.yml`: lint, unit tests, hadolint, shellcheck, compose config | push to `dev`, PRs into `dev` |
| `test` | release candidate | **CI (test)** `ci-test.yml`: build production images, run `docker-compose.prod.yml`, integration tests | push to `test`, PRs into `test` |
| `main` | production | **CD (main)** `ci-main.yml`: build and push multi-arch images, optional deploy | push to `main` |

```mermaid
gitGraph
    commit id: "initial project"
    branch test
    branch dev
    checkout dev
    commit id: "feat: new rank"
    commit id: "fix: typo"
    checkout test
    merge dev id: "promote dev to test"
    checkout main
    merge test id: "release (deploys sha-xxxxxxx)"
```

#### 3.1 Create the branches (once)

```bash
git checkout main && git pull
git checkout -b test && git push -u origin test
git checkout -b dev  && git push -u origin dev
```

#### 3.2 The daily loop

```bash
git checkout dev && git pull
# ... edit, run locally (Part 2) ...
git add -A
git commit -m "feat: add a 'Chaos Monkey' rank"
git push                                   # CI (dev) runs
```

In a team, branch off `dev` instead (`git checkout -b feature/chaos-monkey dev`) and open a PR
into `dev`. `ci-dev.yml` runs on that PR too.

#### 3.3 Promote: dev -> test -> main

1. On GitHub, open a pull request **base `test` <- compare `dev`**. CI (test) runs on the PR.
   Merge it when it is green, and CI (test) runs again on the push to `test`.
2. Open a pull request **base `main` <- compare `test`**. Merge it, and CD (main) builds, pushes and
   (optionally) deploys.

With the GitHub CLI:

```bash
gh pr create --base test --head dev  --title "Promote dev to test"
gh pr create --base main --head test --title "Release"
```

> [!IMPORTANT]
> Use **"Create a merge commit"** for promotion PRs. Squash and rebase merges create *new* commits
> on the target branch that do not exist on the source branch. The branches then drift apart, and
> every later promotion PR shows phantom diffs and conflicts.

#### 3.4 Branch protection (Settings -> Rules -> Rulesets, or Settings -> Branches)

| Branch | Suggested rules |
|--------|-----------------|
| `main` | require a pull request; require the status check **Build images & run integration tests** (it already ran on the tip of `test`, and GitHub shows checks per commit); block force pushes and deletion; in a team, require 1 approval |
| `test` | require a pull request; require **Build images & run integration tests**; block force pushes |
| `dev` | if you use feature branches, require the CI (dev) checks: **Backend - lint & unit tests**, **Frontend - lint & build**, **Hadolint - backend Dockerfile**, **Hadolint - frontend Dockerfile**, **Shellcheck & compose validation**; block force pushes |

A status check only appears in the picker after it has run at least once, so push once to each
branch before you configure the rules.

**Hotfixes:** branch from `main`, fix the bug, and open a PR into `main`. Then merge `main` back
into `test` and `dev` so the fix is not lost at the next promotion.

### Part 4: GitHub Actions and secrets

#### 4.1 Prepare Docker Hub

1. Sign in at <https://hub.docker.com>.
2. Create two **public** repositories, **`bugsquash-backend`** and **`bugsquash-frontend`**
   (*Repositories -> Create repository*). Public images can be pulled by the server without
   logging in.
3. Create an access token under *Account settings -> Personal access tokens -> Generate new token*:
   - Description: `github-actions-bugsquash`
   - Access permissions: **Read & Write** (CI needs to push)
   - Copy the token now, because it is shown only once. Never put your Docker Hub *password* into CI.

#### 4.2 Add secrets and variables

On GitHub, go to your repository -> **Settings -> Secrets and variables -> Actions**.

| Kind | Name | Required? | Value | Used by |
|------|------|-----------|-------|---------|
| Secret | `DOCKER_HUB_USERNAME` | **required** | your Docker Hub account name | `ci-main.yml` (login + image names) |
| Secret | `DOCKER_HUB_ACCESS_TOKEN` | **required** | the token from 4.1 | `ci-main.yml` (login) |
| Secret | `HETZNER_HOST` | auto-deploy only | the server's **IP address** (SSH does not pass through Cloudflare's orange cloud) | deploy job |
| Secret | `HETZNER_USER` | auto-deploy only | `deploy` | deploy job |
| Secret | `HETZNER_SSH_KEY` | auto-deploy only | the **private** key of a dedicated CI key pair, including the BEGIN/END lines | deploy job |
| Secret | `HETZNER_KNOWN_HOSTS` | optional, recommended | output of `ssh-keyscan -t ed25519 <server-ip>`, after you have checked its fingerprint | deploy job (without it: trust-on-first-use plus a warning) |
| Variable | `ENABLE_AUTO_DEPLOY` | optional | `true` turns on the deploy job | `ci-main.yml` |
| Variable | `DEPLOY_PATH` | optional | repository path on the server; default `/opt/devops-workshop` | deploy job |

`ci-dev.yml` and `ci-test.yml` need **no secrets**, so they work on a fresh fork. Section 14 of
[`deploy/hetzner-server-setup.md`](deploy/hetzner-server-setup.md#14-optional-automatic-deploys-from-github-actions)
explains how to create the CI key pair (with a `restrict` prefix in `authorized_keys`) and how to
pin the host key.

> [!NOTE]
> Forked the repository? Enable workflows in the **Actions** tab first. Add the Docker Hub secrets
> **before** your first merge into `main`, otherwise CD (main) fails at "Log in to Docker Hub".

#### 4.3 What each workflow does

| Workflow (UI name) | Jobs | Highlights |
|--------------------|------|-----------|
| `ci-dev.yml` (**CI (dev)**) | 4 jobs (5 checks, because hadolint runs once per Dockerfile), in parallel | `npm ci` from the lockfile, ESLint, `node --test`, `vite build`, hadolint on both Dockerfiles, `shellcheck deploy/deploy.sh`, `docker compose config -q` on both files, plus a negative test that prod compose *refuses* to run without secrets |
| `ci-test.yml` (**CI (test)**) | 1 job | builds both `production` targets, fails if an image runs as root, writes a throwaway `.env.ci` with random secrets, runs `docker compose -f docker-compose.prod.yml up -d --wait`, then the integration tests and curl smoke tests, dumps the logs on failure, and **always** runs `down -v` |
| `ci-main.yml` (**CD (main)**) | `build` (matrix: backend, frontend) and an optional `deploy` | QEMU + Buildx build `linux/amd64,linux/arm64` (Hetzner sells x86 and Ampere Arm), pushes `:latest` and `:sha-<7 chars>`, bakes the short SHA in as `APP_VERSION` / `VITE_APP_VERSION`, caches layers in the GitHub Actions cache per service. `deploy` SSHes in and runs `cd /opt/devops-workshop && git pull --ff-only && ./deploy/deploy.sh sha-<short>`, then curls the public `/api/health` |

All workflows use `permissions: contents: read` (least privilege) and concurrency groups. CI runs
cancel outdated runs; CD runs queue up and are never cancelled halfway through a release. You can
also start any workflow by hand from the **Actions** tab (`workflow_dispatch`). The CD build job
only pushes when it runs on `main`.

### Part 5: Provision the Hetzner server

Follow **[`deploy/hetzner-server-setup.md`](deploy/hetzner-server-setup.md)**. It is the first of
three guides, and each one links to the next. In short:

1. Create an ed25519 SSH key on your laptop.
2. Create a **Debian 13** server in the Hetzner Cloud Console: CX22 (x86) or CAX11 (Arm). The
   multi-arch images run on both.
3. Update the system, create a non-root **`deploy`** user, and harden SSH (keys only, no root login).
4. Turn on unattended security upgrades.
5. Set up the firewall: `ufw` allows only 22, 80 and 443. Read section 7.2 to see **why Docker
   bypasses ufw** and how loopback-only ports fix that.
6. Install Docker Engine from docker.com's apt repository, add `deploy` to the `docker` group
   (be aware that this group is equivalent to root), and install nginx from Debian's apt.
7. Clone the repo to **`/opt/devops-workshop`** and create **`.env.prod`**:

   ```bash
   cd /opt/devops-workshop
   cp .env.prod.example .env.prod && chmod 600 .env.prod
   sed -i -e "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 32)/" \
          -e "s/^JWT_SECRET=.*/JWT_SECRET=$(openssl rand -hex 32)/" .env.prod
   nano .env.prod                  # set DOCKER_HUB_USERNAME
   ```

8. Run the first deploy with `./deploy/deploy.sh`. The app now runs on `127.0.0.1` only.

> [!NOTE]
> **Debian 12 "bookworm"** works too. The main difference is nginx 1.22, which does not know
> `http2 on;`. The guide's [Debian 12 vs 13 table](deploy/hetzner-server-setup.md#debian-12-bookworm-vs-debian-13-trixie)
> lists every difference.

### Part 6: Cloudflare DNS

Follow **[`deploy/cloudflare-dns-guide.md`](deploy/cloudflare-dns-guide.md)**.

1. In the Cloudflare dashboard, open the zone `gulfheight.com` -> **DNS -> Records -> Add record**:
   type `A`, name `devops`, IPv4 = your server, **Proxy status: DNS only (gray cloud)**, TTL Auto.
   An AAAA record for IPv6 is optional.
2. Verify from your laptop: `dig +short devops.gulfheight.com @1.1.1.1` must print your server's IP.

Stay on the **gray cloud** while you get the certificate. You may switch to the orange cloud
afterwards, but then the SSL/TLS mode **must** be **Full (strict)**. **Flexible** causes an
endless redirect loop. The guide explains why, and also how to restore real client IPs behind the
orange cloud.

> [!TIP]
> Create the DNS record as soon as you know the server's IP. Propagation then happens while you
> finish Part 5.

### Part 7: HTTPS with Let's Encrypt

Follow **[`deploy/letsencrypt-setup.md`](deploy/letsencrypt-setup.md)**. This involves a
chicken-and-egg problem: the production nginx config refers to a certificate that does not exist
yet. To get the certificate, Let's Encrypt must reach nginx on port 80, so you start with a
**bootstrap** config:

```bash
cd /opt/devops-workshop
sudo apt install -y certbot python3-certbot-nginx
sudo mkdir -p /var/www/certbot

# 1. HTTP-only bootstrap config (already proxies the app on port 80)
sudo cp deploy/nginx/bootstrap/devops.gulfheight.com.http-only.conf /etc/nginx/conf.d/devops.gulfheight.com.conf
sudo nginx -t && sudo systemctl reload nginx

# 2. Obtain the certificate (add --staging while experimenting)
sudo certbot --nginx -d devops.gulfheight.com

# 3. Swap in the full production config (TLS, HTTP/2, HSTS, security headers, keepalive upstreams)
sudo cp deploy/nginx/conf.d/devops.gulfheight.com.conf /etc/nginx/conf.d/devops.gulfheight.com.conf
sudo nginx -t && sudo systemctl reload nginx

# 4. Prove that automatic renewal will work
sudo certbot renew --dry-run
```

The production config redirects port 80 to HTTPS, except for `/.well-known/acme-challenge/`, which
is served from `/var/www/certbot`. On 443 it proxies `/api/` to `127.0.0.1:3000` and `/` to
`127.0.0.1:8080`. The certificate files are in `/etc/letsencrypt/live/devops.gulfheight.com/`.

### Part 8: Deploy, pin and roll back

All deploys go through one script, [`deploy/deploy.sh`](deploy/deploy.sh). Run it on the server as
the `deploy` user:

```bash
ssh deploy@<server-ip>
cd /opt/devops-workshop
git pull --ff-only                  # deploy.sh and docker-compose.prod.yml live in the repo

./deploy/deploy.sh                  # deploy IMAGE_TAG from .env.prod (default: latest)
./deploy/deploy.sh sha-1a2b3c4      # deploy an exact, immutable build
./deploy/deploy.sh --help
```

The script runs seven steps, and it is safe to run again:

1. **Pre-flight:** checks Docker, Compose, the daemon, `curl` and `.env.prod`. It warns if
   `.env.prod` is readable by other users, and takes a lock so two deploys cannot run at once.
2. **Validate:** runs `docker compose config -q`. A missing secret stops the deploy here, while
   the old version is still serving.
3. **Pull:** only changed layers are downloaded.
4. **Up:** `up -d --remove-orphans --wait`. Compose recreates only the containers that changed and
   waits until their healthchecks pass. On failure the script prints the logs and a rollback command.
5. **Smoke tests:** `127.0.0.1:3000/api/health`, `127.0.0.1:8080/healthz` and
   `127.0.0.1:8080/api/health` (the frontend reaching the backend over Docker DNS).
6. **Clean up:** `docker image prune -f` removes dangling images. Older `sha-*` images are kept,
   so a rollback is instant.
7. **Status:** prints a table of the running services.

**Why pin a `sha-` tag?** `latest` is a *moving* tag: after a pull it points to the new build, so it
cannot take you back. A `sha-<commit>` tag always means exactly one build. The CI deploy job always
deploys the `sha-` tag of the commit it just built.

To find a tag, use any of these:

- the run summary of **CD (main)**, which prints `./deploy/deploy.sh sha-xxxxxxx`;
- the **Tags** tab of the Docker Hub repository;
- `git log --oneline main` (the tag uses the first 7 characters of the commit hash).

**Rolling back:**

```bash
./deploy/deploy.sh sha-<previous-good-commit>
```

- The database volume is untouched. The schema is created with `CREATE TABLE IF NOT EXISTS`, so
  older code still works with it. Real projects need backward-compatible migrations for this to
  hold.
- A rollback lasts until the next deploy. A plain `./deploy/deploy.sh` goes back to `IMAGE_TAG`
  from `.env.prod`, and with auto-deploy on, the next push to `main` ships again. To pin a version,
  set `IMAGE_TAG=sha-...` in `.env.prod`. The usual long-term fix is to `git revert` the bad commit
  on `dev` and promote it ("fix forward").

**Automatic deploys:** add the `HETZNER_*` secrets and set the variable `ENABLE_AUTO_DEPLOY=true`
(see [Part 4](#part-4-github-actions-and-secrets)). The deploy job runs in the GitHub environment
**`production`**. Under *Settings -> Environments -> production* you can add **required reviewers**
so that every release waits for a manual approval click.

Day-2 shortcut on the server:

```bash
alias dc='docker compose -f docker-compose.prod.yml --env-file .env.prod'
dc ps                                     # state + health
dc logs -f --tail=100 backend             # follow the backend logs
dc exec db psql -U bugsquash bugsquash    # SQL shell (the db port is not published)
dc exec -T db pg_dump -U bugsquash bugsquash | gzip > ~/backup-$(date +%F).sql.gz
docker stats                              # memory vs the cgroup limits (512M / 256M / 64M)
```

### Part 9: Verify the deployment

From your laptop:

```bash
curl -s https://devops.gulfheight.com/api/health; echo
# {"status":"ok","db":"up","version":"1a2b3c4","uptime":42}
#                                     ^^^^^^^ the short SHA of the commit that CI built

curl -sI http://devops.gulfheight.com/ | head -n 3        # 301 -> https://devops.gulfheight.com/
curl -sI https://devops.gulfheight.com/ | grep -iE '^(HTTP|strict-transport)'
curl -m 5 http://<server-ip>:3000/api/health              # MUST fail: the API is loopback-only
```

Then open **https://devops.gulfheight.com** in your browser. The page **footer** shows two versions:

- **Web** is the `VITE_APP_VERSION` baked into the JavaScript bundle at build time.
- **API** is the `version` reported by the running backend's `/api/health`, together with a
  healthy / database down / offline indicator.

Both should match the first 7 characters of the commit you merged into `main`
(`git log -1 --format=%h main`). Push a change, watch CD (main) go green, reload the page, and you
can **see** the new deploy arrive.

On the server:

```bash
dc ps                                            # all three services "healthy"
sudo ss -tlnp | grep -E ':(3000|8080)\b'         # must show 127.0.0.1, never 0.0.0.0
sudo certbot certificates                        # certificate and expiry date
```

### Part 10: Troubleshooting

**Local development**

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `Bind for 127.0.0.1:5432 failed: port is already allocated` or `address already in use` | a local Postgres or another stack already uses the port | find it with `sudo ss -ltnp 'sport = :5432'` (Linux) or `lsof -i :5432` (macOS); set `POSTGRES_HOST_PORT=5433` in `.env`. For 3000, 5173 or 8080, stop the other process or the other stack (`docker ps`) |
| Edits are not picked up (macOS / Windows) | file events do not cross Docker Desktop's VM | `VITE_USE_POLLING=true docker compose up` |
| Vite fails after changing `package.json` | the anonymous `node_modules` volume still holds the old dependencies | `docker compose up --build --renew-anon-volumes` |
| `npm ci` on the host fails with `EACCES` in `app/frontend` (Linux) | Docker created an empty, root-owned `app/frontend/node_modules` as the mount point for the anonymous volume | `rmdir app/frontend/node_modules`, then run `npm ci` again |
| backend logs `password authentication failed for user "bugsquash"` | `POSTGRES_PASSWORD` changed after the volume was created (the password is applied on first start only) | dev: `docker compose down -v && docker compose up --build` (deletes local data) |
| `permission denied while trying to connect to the Docker daemon socket` | your user is not in the `docker` group, or you have not logged in again since being added | `sudo usermod -aG docker $USER`, then log out and back in |
| `429` "Too many attempts. The bugs need a break too" | auth rate limit (30 per 15 min per IP), e.g. from many integration test runs | wait, raise `AUTH_RATE_LIMIT_MAX` in `.env`, or `docker compose restart backend` |

**CI/CD**

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| CD (main): `Username and password required` at "Log in to Docker Hub" | `DOCKER_HUB_USERNAME` / `DOCKER_HUB_ACCESS_TOKEN` missing, misspelled, or created as *variables* instead of *secrets* | add them as repository **secrets** with exactly these names |
| CD (main): `denied: requested access to the resource is denied` on push | token is read-only, or the username does not own the token | create a **Read & Write** token for the same account |
| CI (dev): hadolint or shellcheck fails | a Dockerfile or shell best-practice rule (e.g. `DL3018`, `SC2086`) | fix it, or add a justified `# hadolint ignore=DLxxxx` comment above the line |
| CI (test): "runs as root" | a Dockerfile lost its non-root `USER` line | restore `USER 1000:1000` (backend) / `USER 101` (frontend) |
| CI (test): `up --wait` fails | a container crashed or its healthcheck failed | read the "Dump container state and logs" step |
| Deploy job: `Permission denied (publickey)` | CI public key not in `~deploy/.ssh/authorized_keys`, wrong `HETZNER_USER`, or private key pasted without its BEGIN/END lines | see section 14 of the Hetzner guide |
| Deploy job: `Host key verification failed` | `HETZNER_KNOWN_HOSTS` is stale (for example, the server was rebuilt) | regenerate it with `ssh-keyscan`, compare the fingerprint, update the secret |
| Deploy job: `fatal: Not possible to fast-forward, aborting.` | someone edited tracked files or committed on the server | run `git status` on the server, discard or stash the changes, and keep server config in `.env.prod` only |

**Server, nginx, TLS, DNS**

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| nginx-branded **502 Bad Gateway** | the containers are down or still starting, so the host nginx cannot reach `127.0.0.1:3000/8080` | `dc ps`, `dc logs --tail=100 backend`, `./deploy/deploy.sh`; `sudo tail /var/log/nginx/devops.gulfheight.com.error.log` (look for `connect() failed (111: Connection refused)`) |
| `/api/health` returns **503** `"db":"down"` | Postgres is unhealthy, or the password in `.env.prod` no longer matches the volume | `dc logs db`; after changing `POSTGRES_PASSWORD`, also run `ALTER USER` in psql |
| `required variable POSTGRES_PASSWORD is missing a value` | empty secret in `.env.prod`, or a compose command run without `--env-file .env.prod` | fill in `.env.prod`; always use `deploy.sh` or the `dc` alias |
| `pull access denied ... repository does not exist` or `manifest unknown` | wrong `DOCKER_HUB_USERNAME`, private repository, or that tag was never pushed | check Docker Hub; for private repos, `docker login` with a read-only token |
| `exec format error` or `no matching manifest for linux/arm64` | image built for another CPU architecture (e.g. pushed by hand from an x86 laptop) | let CD (main) build it (amd64 + arm64) |
| Login does not stick (you bounce back to the login page) | `COOKIE_SECURE=true` while serving plain HTTP, so the browser drops the cookie | use HTTPS; set `false` only for plain-HTTP tests |
| deploy.sh: "Containers did not become healthy" | crash on startup (missing `JWT_SECRET`, database auth) or out of memory | read the printed logs; `docker inspect --format '{{.State.OOMKilled}}' <container>` |
| `nginx -t`: `cannot load certificate "/etc/letsencrypt/live/..."` | the production config was installed before the certificate existed | go back to the bootstrap config (Part 7, step 1) |
| `nginx -t`: `unknown directive "http2"` | Debian 12 (nginx 1.22) | use `listen 443 ssl http2;` instead of `http2 on;` (commented in the config) |
| certbot: `Timeout during connect (likely firewall problem)` | port 80 blocked by ufw or the Hetzner firewall, or DNS points elsewhere | `sudo ufw status`; `dig +short devops.gulfheight.com @1.1.1.1`; also check for a wrong **AAAA** record |
| certbot: `NXDOMAIN` / wrong IP | DNS record missing or not propagated | [Cloudflare guide](deploy/cloudflare-dns-guide.md#8-troubleshooting), section 8 |
| **ERR_TOO_MANY_REDIRECTS** | Cloudflare orange cloud with SSL mode **Flexible** | SSL/TLS -> **Full (strict)** |
| Cloudflare error **521 / 522 / 526** | origin down, firewall blocking Cloudflare, or invalid or expired origin certificate | `systemctl status nginx`, `sudo certbot certificates` |
| SSH to `devops.gulfheight.com` hangs | the orange cloud does not proxy SSH | SSH to the IP address instead |

More detailed tables are in the [Let's Encrypt guide](deploy/letsencrypt-setup.md#8-troubleshooting)
and the [Cloudflare guide](deploy/cloudflare-dns-guide.md#8-troubleshooting).

---

## API reference

All requests and responses are JSON, and errors look like `{"error": "<message>"}`. Auth uses the
**`bugsquash_token`** cookie, a JWT `{sub: userId, username}` with these attributes:

- `HttpOnly`, `SameSite=Lax`, `Path=/`;
- `Secure` when `COOKIE_SECURE=true`;
- `Max-Age` equal to the JWT lifetime.

| Method | Path | Auth | Request body | Success | Errors |
|--------|------|------|--------------|---------|--------|
| `GET` | `/api/health` | none | | `200 {"status":"ok","db":"up","version":"<APP_VERSION>","uptime":<seconds>}` | `503 {"status":"error","db":"down",...}` |
| `POST` | `/api/auth/signup` | none, rate-limited | `{"username","password"}` | `201 {"user":{"id","username"}}` + `Set-Cookie` | `400` invalid input, `409` username taken, `429` |
| `POST` | `/api/auth/login` | none, rate-limited | `{"username","password"}` | `200 {"user":{"id","username"}}` + `Set-Cookie` | `400` missing fields, `401 {"error":"Invalid username or password"}`, `429` |
| `POST` | `/api/auth/logout` | none | | `204`, cookie cleared | |
| `GET` | `/api/auth/me` | cookie | | `200 {"user":{"id","username"}}` | `401` |
| `POST` | `/api/scores` | cookie | `{"score": 42}` | `201 {"score":{"id","score","createdAt"}}` | `400` not a non-negative integer, `401`, **`422` score > 200** (anti-cheat) |
| `GET` | `/api/scores/me` | cookie | | `200 {"best","gamesPlayed","recent":[{"id","score","createdAt"}]}` (latest 10, newest first) | `401` |
| `GET` | `/api/scores/leaderboard` | none | | `200 {"leaderboard":[{"rank","username","best"}]}`: top 10 by best score; ties share a rank (SQL `RANK()`) | |
| any | `/api/<unknown>` | | | | `404 {"error":"Not found"}` |

Validation rules:

- **Usernames** are 3-20 characters of `[a-zA-Z0-9_]` and unique case-insensitively (a unique
  index on `LOWER(username)`).
- **Passwords** are 8-72 characters and at most 72 bytes, because bcrypt ignores anything longer.
  They are hashed with bcryptjs at cost 10.
- **Scores** are integers from 0 to **200** (`MAX_SCORE`), checked on the server.
- **Requests:** malformed JSON gets `400`, and bodies over 10 kB get `413`.
- **Rate limit:** signup and login allow `AUTH_RATE_LIMIT_MAX` requests (default 30) per 15
  minutes per IP.

Try it against the dev stack:

```bash
JAR=/tmp/bugsquash.cookies
curl -s -c $JAR -H 'Content-Type: application/json' \
     -d '{"username":"alice","password":"correct-horse"}' http://localhost:3000/api/auth/signup; echo
curl -s -b $JAR -H 'Content-Type: application/json' -d '{"score":42}'   http://localhost:3000/api/scores; echo
curl -s -b $JAR -H 'Content-Type: application/json' -d '{"score":9001}' http://localhost:3000/api/scores; echo  # 422
curl -s -b $JAR http://localhost:3000/api/scores/me; echo
curl -s http://localhost:3000/api/scores/leaderboard; echo
```

---

## Environment variables

| Variable | Used by | Dev default (`docker-compose.yml`) | Production (`.env.prod`) | Notes |
|----------|---------|------------------------------------|--------------------------|-------|
| `POSTGRES_DB` | db; backend as `PGDATABASE` | `bugsquash` | `bugsquash` | applied when the volume is first created |
| `POSTGRES_USER` | db; backend as `PGUSER` | `bugsquash` | `bugsquash` | applied when the volume is first created |
| `POSTGRES_PASSWORD` | db; backend as `PGPASSWORD` | `bugsquash-dev-password` | **required** (`openssl rand -hex 32`) | changing it later also needs `ALTER USER` |
| `POSTGRES_HOST_PORT` | dev compose only | `5432` | | host port for psql or GUI clients |
| `JWT_SECRET` | backend | `dev-only-insecure-secret-change-me` | **required** | the backend refuses to start without it when `NODE_ENV=production`; rotating it logs everyone out |
| `JWT_EXPIRES_IN` | backend | `7d` | `7d` | `60s`, `15m`, `12h`, `7d`; a bare number means seconds |
| `COOKIE_SECURE` | backend | `false` | `true` | `true` = cookie sent over HTTPS only |
| `AUTH_RATE_LIMIT_MAX` | backend | `30` | `30` | signup and login attempts per IP per 15 min |
| `APP_VERSION` | backend | `dev` | *not set*: baked into the image by CI (short SHA) | shown in `/api/health` and the footer |
| `VITE_APP_VERSION` | frontend build arg | `dev` | baked in by CI (short SHA) | shown in the footer as "Web" |
| `VITE_USE_POLLING` | Vite dev server | `false` | | `true` on Docker Desktop if hot reload misses edits |
| `VITE_API_PROXY_TARGET` | Vite dev server | `http://backend:3000` (set by compose) | | `vite.config.js` falls back to `http://localhost:3000` |
| `DOCKER_HUB_USERNAME` | prod compose image names | | **required** | `<user>/bugsquash-backend`, `<user>/bugsquash-frontend` |
| `IMAGE_TAG` | prod compose | | `latest` | `./deploy/deploy.sh <tag>` overrides it for one deploy |

Set by the compose files, not by you: `NODE_ENV`, `PORT=3000`, `PGHOST=db`, `PGPORT=5432`.

Tool-only variables:

- `BASE_URL` for the integration tests (default `http://localhost:8080`), and `API_ONLY=1` when
  `BASE_URL` is the bare API (for example `http://localhost:3000`);
- `WAIT_TIMEOUT` (default 180 s), `NO_COLOR` and `SKIP_PULL=1` for `deploy/deploy.sh`.

---

## Make it your own: exercises and stretch goals

**Warm-up: follow one change all the way to production**

1. Add a new rank title in `app/frontend/src/js/ranks.js`, or change the anti-cheat message in
   `app/backend/src/validation.js`. Watch hot reload pick it up locally.
2. Push to `dev`, then promote it `dev -> test -> main`. Watch all three workflows run.
3. Confirm the new short SHA in the footer and in `/api/health`. Then roll back with
   `./deploy/deploy.sh sha-<previous>` and watch the footer change back.

**Containers and Linux** (pair these with [the theory chapter](docs/containers-deep-dive.md))

Run these in the production stack, for example the local rehearsal from
[Part 2.6](#26-rehearse-the-production-stack-locally-optional), with
`alias dc='docker compose -f docker-compose.prod.yml --env-file .env.ci'`.

- **PID 1 and signals.** Comment out the two `process.on('SIGTERM' / 'SIGINT')` lines in
  `app/backend/src/server.js`, rebuild the production image and run `time dc stop backend`. Then
  check `docker inspect -f '{{.State.ExitCode}}' bugsquash-backend-1`. Use what you know about
  PID 1 and SIGKILL to explain the 10 seconds and the exit code 137. Then try a shell-form
  `CMD node src/server.js; echo bye`.
- **cgroups.** Lower the backend memory limit to `32M`. Watch `docker stats`, and check
  `docker inspect -f '{{.State.OOMKilled}}' bugsquash-backend-1`.
- **Network isolation.** Run `dc exec frontend wget -T 3 -O- http://db:5432` and compare it with the
  same command from the backend. Explain the difference with `docker network inspect bugsquash_data`.
- **Read-only root filesystem.** `dc exec backend touch /home/node/x` fails even though the `node`
  user owns that directory, while `dc exec backend touch /tmp/x` works. Explain both results with
  overlay layers and tmpfs.

**Features (touch every layer: API, unit test, integration test, UI)**

- Add `GET /api/scores/stats` (total games, total bugs squashed) and show it on the landing page.
- Add a "daily leaderboard" (`WHERE created_at > now() - interval '1 day'`). Think about which index
  it needs.
- Move the round length (`ROUND_MS` in `game.js`) into a server-provided config, and make the
  anti-cheat limit depend on it.

**DevOps stretch goals**

- **Backups.** Run a nightly `pg_dump` from cron or a systemd timer, copy it off the server
  (Hetzner Storage Box or object storage), and practise a **restore**.
- **Security scanning.** Add a Trivy or Docker Scout step to `ci-test.yml` that fails on critical
  CVEs. Enable Dependabot for npm, GitHub Actions and Dockerfiles. Pin actions by commit SHA.
- **Monitoring.** Point an uptime checker (e.g. Uptime Kuma) at `/api/health`. Add a Prometheus
  `/metrics` endpoint and a Grafana dashboard.
- **Staging.** Deploy the `test` branch to `staging.devops.gulfheight.com` with its own Compose
  project name, `.env.staging` and nginx server block.
- **Zero-downtime deploys.** Run two backend replicas (blue/green) behind an nginx upstream and
  switch between them. Note that the in-memory rate limiter then needs a shared store such as Redis.
- **Edge rate limiting.** Add nginx `limit_req` for `/api/auth/` in the host config, and compare it
  with the app-level limiter.
- **Cloudflare orange cloud.** Switch to proxied mode with Full (strict), enable the `real_ip` block
  in the nginx config, and check that the rate limiter still sees real client IPs.

**Use your own domain.** Replace `devops.gulfheight.com` in these places:

1. the `server_name`, redirect and certificate paths in both files under `deploy/nginx/` (and,
   if you like, the file names);
2. the `certbot -d` command;
3. the `environment.url` and the "Verify the public site" step in `.github/workflows/ci-main.yml`;
4. the final message of `deploy/deploy.sh`;
5. your DNS record.

Then run `grep -rn "gulfheight" --exclude-dir=node_modules .` to catch the rest.
