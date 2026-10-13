# Zero-to-Hero DevOps Workshop: Bug Squash Arena

![What we'll build: code goes from your laptop through GitHub, GitHub Actions and Docker Hub to a Google Cloud VM, where Docker runs the nginx proxy, frontend, backend, PostgreSQL and certbot; visitors find it through Cloudflare DNS and connect over HTTPS. Pink badges mark the five deployment stages.](docs/images/architecture-overview.svg)

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
![Google Cloud](https://img.shields.io/badge/Google%20Cloud-Debian%2013-4285F4?logo=googlecloud&logoColor=white)
![Cloudflare DNS](https://img.shields.io/badge/Cloudflare-DNS-F38020?logo=cloudflare&logoColor=white)
![Let's Encrypt](https://img.shields.io/badge/Let%27s%20Encrypt-TLS-003A70?logo=letsencrypt&logoColor=white)

**Bug Squash Arena** is a small, silly DevOps-themed clicker game. You sign up, a bug hops around a
circuit board for 10 seconds, every click squashes it for +1 point, and your best score climbs a
public top-10 leaderboard under a rank title from "Intern" to "10x Engineer".

The game is just the excuse. The real subject is the **path code travels** from your laptop to a real
website: you run the stack locally with Docker Compose, promote changes through `dev -> test -> main`,
let GitHub Actions test, build and push the images, and then take them, stage by stage, to a Google
Cloud VM that serves **https://devops.gulfheight.com**. There is deliberately no Kubernetes: one VM and
one Compose file, so every moving part stays visible.

## Table of contents

- [What you will learn](#what-you-will-learn)
- [Tech stack](#tech-stack)
- [Repository structure](#repository-structure)
- [Part 0: Prerequisites](#part-0-prerequisites)
- [Part 1: Theory first](#part-1-theory-first)
- [Part 2: Run it locally](#part-2-run-it-locally)
- [Part 3: Git branching strategy](#part-3-git-branching-strategy)
- [Part 4: GitHub Actions and secrets](#part-4-github-actions-and-secrets)
- [Part 5: The deployment journey](#part-5-the-deployment-journey)
- [Part 6: Troubleshooting](#part-6-troubleshooting)
- [API reference](#api-reference)
- [Environment variables](#environment-variables)
- [Make it your own](#make-it-your-own)

## What you will learn

- **What a container really is**: a Linux process isolated by namespaces, limited by cgroups v2 and
  running on an overlay filesystem. You prove it on our VM, where Alpine and Debian containers report
  the VM's own kernel.
- **Production-grade Dockerfiles**: multi-stage builds, cache-friendly layer order, non-root users,
  exec-form `CMD`, `HEALTHCHECK`s and a version stamped into every image.
- **Docker Compose in two roles**: a hot-reload dev stack, and a hardened production stack with
  resource limits, read-only root filesystems, an internal database network, log rotation, and one
  edge proxy as the only container that publishes ports.
- **Twelve-Factor configuration**: settings live in environment variables, secrets never enter Git,
  and the stack refuses to start when one is missing.
- **CI/CD with GitHub Actions**: lint, unit tests, `hadolint`, `shellcheck`, integration tests against
  the real production Compose file, multi-arch image builds, and an SSH deploy job.
- **Release engineering**: immutable `sha-<commit>` image tags, one-command rollbacks, smoke tests,
  and a footer that shows which commit is live.
- **A real server, one stage at a time**: a Google Cloud VM, a static IP and firewall rules,
  Cloudflare DNS, Let's Encrypt HTTPS with nginx and certbot as containers, then automation with a
  deploy script, CI and (optionally) Ansible.

## Tech stack

| Layer | Technology | Where |
|-------|------------|-------|
| Frontend | Vite 8 multi-page app, vanilla JavaScript modules (no framework), ESLint 10 | [`app/frontend/`](app/frontend/) |
| Frontend runtime | `nginxinc/nginx-unprivileged:1.30.5-alpine3.24` (non-root, port 8080) | [`app/frontend/Dockerfile`](app/frontend/Dockerfile), [`app/frontend/nginx.conf`](app/frontend/nginx.conf) |
| Backend | Node.js 24 (`node:24.21.0-alpine3.24`), Express 5, `pg`, `bcryptjs`, `jsonwebtoken`, `helmet`, `express-rate-limit`, ESLint 9 | [`app/backend/`](app/backend/) |
| Database | PostgreSQL 17 (`postgres:17.11-alpine3.24`), schema created by the backend at startup | [`app/backend/src/db.js`](app/backend/src/db.js) |
| Edge proxy | `nginx:1.30.5-alpine3.24` container: reverse proxy, TLS, HTTP/2 | [`deploy/nginx/`](deploy/nginx/) |
| Certificates | Let's Encrypt through the `certbot/certbot` container, renewed by a systemd timer | [`deploy/tls.sh`](deploy/tls.sh), [`deploy/systemd/`](deploy/systemd/) |
| Orchestration | Docker Compose: dev project `bugsquash-dev`, production project `bugsquash` | [`docker-compose.yml`](docker-compose.yml), [`docker-compose.prod.yml`](docker-compose.prod.yml) |
| Tests | `node:test` unit tests (fake DB), zero-dependency integration tests using `fetch` | [`app/backend/test/`](app/backend/test/), [`tests/integration/`](tests/integration/) |
| CI/CD | GitHub Actions, Docker Buildx + QEMU, Docker Hub | [`.github/workflows/`](.github/workflows/) |
| Server | Google Compute Engine VM `devops` (`e2-medium`, `europe-central2-a`), Debian 13 | [Google Cloud reference](deploy/gcp-vm-setup.md) |
| DNS | Cloudflare, A record `devops.gulfheight.com` | [Stage 2](deploy/stage-2-domain-http.md) |
| Provisioning (optional) | Ansible: one command sets up or rebuilds the VM | [`ansible/`](ansible/README.md) |

## Repository structure

```text
.
├── README.md                    you are here
├── .env.example                 local dev overrides (optional: cp .env.example .env)
├── .env.prod.example            production settings template (Stage 1: cp to .env.prod on your laptop)
├── docker-compose.yml           LOCAL DEV: builds "dev" targets, bind mounts, hot reload
├── docker-compose.prod.yml      PRODUCTION: pulled images, proxy + certbot, limits, two networks
├── .github/workflows/
│   ├── ci-dev.yml               dev:  lint, unit tests, hadolint, shellcheck, compose/nginx/systemd/Ansible checks
│   ├── ci-test.yml              test: build prod images, run deploy.sh in HTTP and HTTPS mode, integration tests
│   └── ci-main.yml              main: multi-arch build + push to Docker Hub, optional deploy (Stage 4)
├── app/
│   ├── backend/                 Express 5 REST API (Node 24)
│   │   ├── Dockerfile           multi-stage: base -> dev | prod-deps -> production
│   │   ├── src/                 server.js (SIGTERM shutdown), app.js, config.js, db.js, routes/, middleware/
│   │   └── test/                node:test unit tests with a fake DB (no Postgres needed)
│   └── frontend/                Vite multi-page app, vanilla JS modules
│       ├── Dockerfile           multi-stage: dev (vite :5173) | build -> production (nginx :8080)
│       ├── nginx.conf           static files, /healthz, /api/ proxy, caching, CSP
│       ├── *.html               index, login, signup, dashboard, 404
│       └── src/js/, src/styles/ one module per page + api.js, game.js, ranks.js ...
├── tests/integration/api.test.mjs   black-box API tests: node:test + fetch, zero dependencies
├── deploy/                      the "deploy bundle" that goes to the VM, plus the stage guides
│   ├── stage-1-ip-http.md ... stage-4-automated-deploys.md    the deployment journey (Part 5)
│   ├── gcp-vm-setup.md          Google Cloud reference: machine types, static IP, firewall, costs
│   ├── nginx/                   config of the proxy container
│   │   ├── select-site-config.sh    picks the HTTP-only or the HTTPS config at every start
│   │   ├── templates/           http-only/ and https/ site.conf.template
│   │   └── snippets/            shared pieces: routing, ACME challenge, /healthz, headers
│   ├── tls.sh                   Stage 3 shortcut: issue / renew / status, via the certbot container
│   ├── systemd/                 bugsquash-tls-renew.service + .timer: renewal twice a day
│   └── deploy.sh                Stage 4: pull, up --wait, reload the proxy, smoke tests, prune
├── ansible/                     Stage 5 (optional): provision.sh, site.yml, backup.yml, roles/
└── docs/containers-deep-dive.md theory: namespaces, cgroups v2, overlayfs, VMs vs containers
```

Every config file is heavily commented on purpose: the comments explain *why* each line is there.

## Part 0: Prerequisites

| Tool on your laptop | Check | Notes |
|---------------------|-------|-------|
| Git | `git --version` | |
| Docker Engine 24+ with the Compose v2 plugin, or Docker Desktop | `docker compose version` | Windows: use WSL 2 and keep the repository *inside* the WSL filesystem; bind mounts from `C:\` are slow |
| Node.js 24 (optional) | `node --version` | only to run lint and tests *outside* containers |
| Google Cloud CLI (optional) | `gcloud --version` | Stage 1 works in the web console; the CLI versions are in its *Going deeper* and the [Google Cloud reference](deploy/gcp-vm-setup.md) |

| Account | Cost | Used for |
|---------|------|----------|
| GitHub | free | repository, pull requests, Actions |
| Docker Hub | free | your own images, from [Part 4](#part-4-github-actions-and-secrets) on. Stages 1 to 3 run the course's public images (`alhuraibisaeed`) |
| Google Cloud | pay-as-you-go; new accounts get free-trial credit that covers the course | the VM ([costs and cleanup](deploy/gcp-vm-setup.md#5-costs-and-cleanup)) |
| Cloudflare + a domain | free plan | DNS. The course uses `gulfheight.com`; see [Make it your own](#make-it-your-own) for yours |

You need basic terminal use (`cd`, `ls`, editing a file) and basic Git (`clone`, `commit`, `push`).

## Part 1: Theory first

Read **[`docs/containers-deep-dive.md`](docs/containers-deep-dive.md)** before you type
`docker compose up`. It explains what a container is from first principles, and every claim comes
with a command you can run:

| Chapter | Why it matters for this repo |
|---------|------------------------------|
| 1. Containers vs Docker | Docker is a toolchain; the isolation itself comes from the kernel |
| 2. Namespaces | why each container has its own `localhost` and ports, and why your app is PID 1 |
| 3. cgroups v2 | what `deploy.resources.limits` in `docker-compose.prod.yml` really does (and the OOM killer) |
| 4. Overlay filesystem and layers | why the Dockerfiles copy `package*.json` before the source code |
| 5. VMs vs containers | why we run containers *inside* a Google Cloud VM |
| 6. Proof: the shared kernel | captured on our VM: Debian and Alpine containers print the VM's kernel |
| 7. [How this repo uses these concepts](docs/containers-deep-dive.md#7-how-this-repo-uses-these-concepts) | every production setting mapped to the kernel feature behind it |
| 8. Review questions | 14 quiz questions with hidden answers |

> [!TIP]
> Run the experiments on Linux, or later on your VM. Docker Desktop on macOS and Windows runs
> containers inside a hidden VM, so some outputs differ (chapter 6.6 explains why).

## Part 2: Run it locally

### 2.1 Start the stack

```bash
git clone https://github.com/<your-account>/<your-repo>.git
cd <your-repo>
docker compose up --build
```

No `.env` file is needed: every variable in `docker-compose.yml` has a safe development default. The
first build takes a few minutes; later starts take seconds thanks to layer caching. When the logs
settle, open **http://localhost:5173**, sign up and squash some bugs.

| Service | Container | Published on | What it is |
|---------|-----------|--------------|------------|
| `frontend` | `bugsquash-dev-frontend-1` | http://localhost:5173 | Vite dev server; proxies `/api` to `http://backend:3000` |
| `backend` | `bugsquash-dev-backend-1` | http://localhost:3000 | Express API run by `node --watch` |
| `db` | `bugsquash-dev-db-1` | `localhost:5432` | PostgreSQL 17, data in the volume `bugsquash-dev_pgdata` |

All three are bound to `127.0.0.1`, so other devices on your Wi-Fi cannot reach them. The browser only
talks to `:5173`; because the page and the API share that origin, the login cookie simply works and no
CORS configuration is needed.

```bash
curl -s http://localhost:3000/api/health; echo
# {"status":"ok","version":"dev"}
```

To override a default, `cp .env.example .env` (git-ignored) and edit it, for example
`POSTGRES_HOST_PORT=5433` if a local Postgres already uses 5432.

### 2.2 Hot reload

- **Backend:** `./app/backend/src` is bind-mounted over `/app/src`. Edit a file (for example the
  anti-cheat message in `app/backend/src/validation.js`) and `node --watch` restarts the server within
  a second: `docker compose logs -f backend`.
- **Frontend:** the whole `./app/frontend` folder is bind-mounted. Edit `app/frontend/src/js/ranks.js`
  (rank titles) or a CSS file and the browser updates instantly. An *anonymous volume* masks
  `/app/node_modules`, so your host's files never hide the Linux `node_modules` from the image.
- **macOS / Windows:** if edits are not picked up, start with `VITE_USE_POLLING=true docker compose up`.
- **Changed `package.json`?** `docker compose up --build --renew-anon-volumes`.

### 2.3 Look inside the database

```bash
docker compose exec db psql -U bugsquash bugsquash
```

```sql
\dt                                            -- tables: users, scores
SELECT id, username, created_at FROM users ORDER BY id;
SELECT u.username, MAX(s.score) AS best, COUNT(*) AS games
  FROM scores s JOIN users u ON u.id = s.user_id
 GROUP BY u.username ORDER BY best DESC;
\q
```

GUI clients (DBeaver, pgAdmin) connect to
`postgresql://bugsquash:bugsquash-dev-password@localhost:5432/bugsquash`.

### 2.4 Lint and unit tests

The same checks `ci-dev.yml` runs:

```bash
docker compose exec backend  npm run lint
docker compose exec backend  npm test        # node:test, fake DB, no Postgres needed
docker compose exec frontend npm run lint
```

> [!NOTE]
> Only the backend's `src/` is bind-mounted; `test/` is copied in at build time, so rebuild after
> editing a test: `docker compose up --build -d backend`. Or run the tests on the host with Node 24:
> `cd app/backend && npm ci && npm test`. On Linux, a host `npm ci` in `app/frontend` fails with
> `EACCES` once the dev stack has run: Docker left an empty, root-owned `node_modules` mount point.
> Remove it with `rmdir app/frontend/node_modules` (no `sudo` needed).

### 2.5 Integration tests

[`tests/integration/api.test.mjs`](tests/integration/api.test.mjs) tests the running system from the
outside: it signs up a unique user, logs in, posts scores, checks the anti-cheat rule and reads the
leaderboard. It has zero npm dependencies (`node:test` plus the built-in `fetch`).

```bash
# against the dev stack (Node 18+ on the host)
BASE_URL=http://localhost:5173 node --test tests/integration/api.test.mjs

# straight against the API; API_ONLY=1 skips the one test that expects the HTML landing page
API_ONLY=1 BASE_URL=http://localhost:3000 node --test tests/integration/api.test.mjs

# no Node on the host? (Linux) a throwaway container sharing the host's network namespace
docker run --rm --network host -v "$PWD/tests:/tests:ro" -e BASE_URL=http://localhost:5173 \
  node:24.21.0-alpine3.24 node --test /tests/integration/api.test.mjs
```

Each run makes 5 requests to the rate-limited auth endpoints (30 per 15 minutes per IP). On `429`,
wait or `docker compose restart backend`: the counter lives in process memory.

> [!WARNING]
> Never point the integration tests at production. Each run leaves a player called `it_<random>`
> with a score of 200 on the public leaderboard.

### 2.6 Rehearse the production stack locally (optional)

This is what `ci-test.yml` does: the real `docker-compose.prod.yml`, with images built on your laptop
instead of pulled from Docker Hub. The dev stack can keep running, because the production stack only
publishes ports 80 and 443.

```bash
docker build --target production -t local/bugsquash-backend:ci  app/backend
docker build --target production -t local/bugsquash-frontend:ci app/frontend

cat > .env.ci <<EOF
DOCKER_HUB_USERNAME=local
IMAGE_TAG=ci
DOMAIN=localhost
COOKIE_SECURE=false
POSTGRES_PASSWORD=$(openssl rand -hex 32)
JWT_SECRET=$(openssl rand -hex 32)
EOF

docker compose -f docker-compose.prod.yml --env-file .env.ci up -d --wait
BASE_URL=http://localhost node --test tests/integration/api.test.mjs
# open http://localhost: proxy -> frontend / backend -> db, the same path as on the VM
docker compose -f docker-compose.prod.yml --env-file .env.ci down -v
rm .env.ci
```

`.env.ci` is git-ignored like every `.env.*` file, and it is not called `.env.prod` on purpose: it
must never overwrite the production settings you create in Stage 1. `COOKIE_SECURE=false` lets the
browser log in over plain `http://localhost`.

### 2.7 Useful Docker commands

| Command | What it shows / does |
|---------|----------------------|
| `docker compose ps` | services, state, **health**, ports |
| `docker compose logs -f backend` | follow one service's output |
| `docker compose exec backend sh` | a shell inside the container (Alpine has `sh`, not `bash`) |
| `docker compose exec backend ps` | the container's PID namespace: PID 1 is `docker-init` (tini) because of `init: true` |
| `docker compose restart backend` | `SIGTERM` -> graceful shutdown -> start again |
| `docker compose down` | stop and remove containers; **keeps** the database volume |
| `docker compose down -v` | ...and **deletes** the database volume (fresh start) |
| `docker stats` | live CPU and memory per container (read from cgroups) |
| `docker image ls` / `docker history <image>` | images and the layers they are made of |
| `docker network inspect bugsquash-dev_default` | which containers share the bridge network |
| `docker volume ls` / `docker system df` | volumes; disk used by images, containers and volumes |

## Part 3: Git branching strategy

Each branch is an environment, and each has its own quality gate:

| Branch | Purpose | Workflow | Runs on |
|--------|---------|----------|---------|
| `dev` | day-to-day work | **CI (dev)** `ci-dev.yml`: lint, unit tests, static checks | push to `dev`, PRs into `dev` |
| `test` | release candidate | **CI (test)** `ci-test.yml`: production images + integration tests | push to `test`, PRs into `test` |
| `main` | production | **CD (main)** `ci-main.yml`: build and push images, optional deploy | push to `main` |

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

### 3.1 Create the branches (once)

```bash
git checkout main && git pull
git checkout -b test && git push -u origin test
git checkout -b dev  && git push -u origin dev
```

### 3.2 The daily loop

```bash
git checkout dev && git pull
# ... edit, run locally (Part 2) ...
git add -A
git commit -m "feat: add a 'Chaos Monkey' rank"
git push                                   # CI (dev) runs
```

In a team, branch off `dev` (`git checkout -b feature/chaos-monkey dev`) and open a PR into `dev`;
`ci-dev.yml` runs on the PR too.

### 3.3 Promote: dev -> test -> main

1. On GitHub, open a pull request **base `test` <- compare `dev`**. CI (test) runs on the PR; merge it
   when it is green.
2. Open a pull request **base `main` <- compare `test`** and merge it. CD (main) builds, pushes and,
   from Stage 4 on, deploys.

```bash
gh pr create --base test --head dev  --title "Promote dev to test"
gh pr create --base main --head test --title "Release"
```

> [!IMPORTANT]
> Use **"Create a merge commit"** for promotion PRs. Squash and rebase merges create *new* commits on
> the target branch, the branches drift apart, and every later promotion shows phantom diffs.

### 3.4 Branch protection (Settings -> Rules -> Rulesets)

| Branch | Suggested rules |
|--------|-----------------|
| `main` | require a pull request; require the check **Build images & run integration tests**; block force pushes and deletion; in a team, 1 approval |
| `test` | require a pull request; require **Build images & run integration tests**; block force pushes |
| `dev` | with feature branches, require the CI (dev) checks (**Backend - lint & unit tests**, **Frontend - lint & build**, both **Hadolint** checks, **Shellcheck, compose & systemd validation**, **Proxy config - render both modes & nginx -t**, **Ansible - lint & syntax check**); block force pushes |

A check only appears in the picker after it has run once, so push to each branch first.
**Hotfixes:** branch from `main`, fix, PR into `main`, then merge `main` back into `test` and `dev`.

## Part 4: GitHub Actions and secrets

### 4.1 Prepare Docker Hub

1. Sign in at <https://hub.docker.com> and create two **public** repositories,
   **`bugsquash-backend`** and **`bugsquash-frontend`**. The VM pulls public images without a login.
2. Create an access token: *Account settings -> Personal access tokens -> Generate new token*,
   description `github-actions-bugsquash`, permissions **Read & Write**. Copy it now; it is shown
   once. Never give CI your Docker Hub *password*.

### 4.2 Add secrets and variables

GitHub -> your repository -> **Settings -> Secrets and variables -> Actions**:

| Kind | Name | Value | Needed for |
|------|------|-------|------------|
| Secret | `DOCKER_HUB_USERNAME` | your Docker Hub account name | CD (main): login and image names |
| Secret | `DOCKER_HUB_ACCESS_TOKEN` | the token from 4.1 | CD (main): login |
| Secrets | `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS` | the VM's address and a dedicated SSH key | the deploy job, set up in [Stage 4, step 6](deploy/stage-4-automated-deploys.md#6-add-the-github-secrets-and-the-switch) |
| Variables | `ENABLE_AUTO_DEPLOY`, `DEPLOY_PATH`, `SITE_URL` | `true` switches the deploy job on | the deploy job (Stage 4) |

`ci-dev.yml` and `ci-test.yml` need **no secrets**, so they work on a fresh fork.

> [!NOTE]
> Forked the repository? Enable workflows in the **Actions** tab first, and add the two Docker Hub
> secrets **before** your first merge into `main`, or CD (main) fails at "Log in to Docker Hub".

### 4.3 What each workflow does

| Workflow (UI name) | Jobs | Highlights |
|--------------------|------|------------|
| `ci-dev.yml` (**CI (dev)**) | 6 jobs in parallel (7 checks: hadolint runs per Dockerfile) | `npm ci` from the lockfile, ESLint, `node --test`, `vite build`, hadolint, `shellcheck` on every script, `docker compose config` on both files (and a test that prod compose *refuses* to start without secrets), the renewal timer's systemd units, the proxy config rendered in HTTP-only and HTTPS mode and checked with `nginx -t`, `ansible-lint` |
| `ci-test.yml` (**CI (test)**) | 1 job | builds both `production` images and fails if one runs as root, runs the real `deploy/deploy.sh` (`SKIP_PULL=1`) with a throwaway `.env.prod`, checks that only the proxy publishes ports, runs the integration tests through the proxy over HTTP, switches to HTTPS with a self-signed certificate and tests again (redirect, HTTP/2, HSTS), and **always** tears everything down |
| `ci-main.yml` (**CD (main)**) | `build` (backend, frontend) + optional `deploy` | QEMU + Buildx build `linux/amd64,linux/arm64`, push `:latest` and `:sha-<7 chars>`, bake the short SHA in as `APP_VERSION` / `VITE_APP_VERSION`. `deploy` (Stage 4, only with `ENABLE_AUTO_DEPLOY=true`) copies the bundle with `rsync`, runs `./deploy/deploy.sh sha-<short>` over SSH and checks the public `/api/health` |

All workflows use `permissions: contents: read` and concurrency groups: CI cancels outdated runs, CD
runs queue up and are never cancelled halfway through a release. Every workflow can also be started
by hand from the **Actions** tab.

## Part 5: The deployment journey

Your laptop runs the game; now it goes live. You move the same production stack to a Google Cloud VM
in five small stages. Each stage works end to end before the next one adds a single new idea: first
everything by hand with `scp`, so you see every moving part, then automation, so you never have to do
it by hand again.

| Stage | Goal | What you do | Result | Guide |
|-------|------|-------------|--------|-------|
| 1 | The app on a bare IP | create the VM, install Docker, `scp` three things, `docker compose up -d` | `http://<VM-IP>` | [Stage 1](deploy/stage-1-ip-http.md) |
| 2 | A name for the site | add one Cloudflare A record, set `DOMAIN` | `http://devops.gulfheight.com` | [Stage 2](deploy/stage-2-domain-http.md) |
| 3 | HTTPS | get a Let's Encrypt certificate with the certbot container, install the renewal timer | `https://devops.gulfheight.com` | [Stage 3](deploy/stage-3-https.md) |
| 4 | Automated deploys | `deploy.sh`, a no-sudo `deploy` user, and GitHub Actions deploying every merge into `main` | the footer shows your merged commit | [Stage 4](deploy/stage-4-automated-deploys.md) |
| 5 (optional) | The VM as code | one Ansible command provisions, or rebuilds, the VM with its data and certificate | the same site on a brand-new VM | [Stage 5](ansible/README.md) |

Google Cloud details (machine types, static IP, firewall rules, IAP, costs and cleanup) are in the
[Google Cloud reference](deploy/gcp-vm-setup.md).

### 5.1 How code and settings reach the VM

The VM never gets a Git checkout. It holds a small **deploy bundle** in `/opt/devops-workshop`
(`docker-compose.prod.yml`, `.env.prod`, `deploy/`) and pulls ready-made images from Docker Hub.

```mermaid
flowchart LR
    LAPTOP["Your laptop<br/>docker-compose.prod.yml<br/>.env.prod, deploy/"]
    GH["GitHub<br/>dev, test, main"]
    GHA["GitHub Actions<br/>ci-dev, ci-test, ci-main"]
    HUB[("Docker Hub<br/>bugsquash-backend<br/>bugsquash-frontend")]
    VM["VM devops<br/>/opt/devops-workshop"]

    LAPTOP -->|"git push"| GH
    GH -->|"push / pull request"| GHA
    GHA -->|"docker push :latest, :sha-xxxxxxx"| HUB
    HUB -->|"docker compose pull"| VM
    LAPTOP -->|"stages 1-3: scp, by hand"| VM
    GHA -->|"stage 4: rsync the bundle,<br/>ssh ./deploy/deploy.sh"| VM
    LAPTOP -.->|"stage 5, optional:<br/>ansible/provision.sh"| VM
```

The same in plain text:

```text
                       stages 1-3: scp, by hand
  +------------+ ---------------------------------------------> +----------------------+
  | laptop     |   stage 5 (optional): ansible/provision.sh     | VM "devops"          |
  |            | ---------------------------------------------> | /opt/devops-workshop |
  +------------+                                                +----------------------+
        | git push                                                 ^              ^
        v                                                          |              |
  +------------+  push / PR   +----------------+  stage 4: rsync   |              |
  | GitHub     | -----------> | GitHub Actions | ------------------'              |
  +------------+              +----------------+  + ssh deploy.sh                 |
                                      | docker push                               |
                                      v                                           |
                              +----------------+  docker compose pull             |
                              | Docker Hub     | ---------------------------------'
                              +----------------+
```

`.env.prod` (the secrets) travels only from your laptop, or from Ansible's encrypted vault in Stage 5.
CI never sees it.

### 5.2 How a request reaches the app

```mermaid
flowchart LR
    B(["Browser"])
    FW{{"Google VPC firewall<br/>tcp 22, 80, 443"}}
    CF["Cloudflare DNS<br/>A record, grey cloud"]
    subgraph VM["VM devops: Debian 13, only Docker installed"]
        PX["proxy<br/>nginx:1.30.5-alpine3.24<br/>publishes :80 and :443"]
        FE["frontend<br/>nginx-unprivileged :8080"]
        BE["backend<br/>Express :3000"]
        DB[("db<br/>postgres 17 :5432")]
        CB["certbot<br/>one-off container"]
        LE[("volume<br/>letsencrypt")]
    end
    B ==>|"2. HTTP / HTTPS<br/>to the VM's IP"| FW
    FW ==> PX
    B -.->|"1. where is<br/>devops.gulfheight.com?"| CF
    PX ==>|"/"| FE
    PX ==>|"/api/"| BE
    BE ==>|"network data<br/>(internal)"| DB
    CB -->|"writes certificates"| LE
    LE -.->|"read-only"| PX
```

The same in plain text:

```text
 browser --1. "devops.gulfheight.com?"--> Cloudflare DNS: A record -> 34.118.95.243 (grey cloud)
    |
    | 2. http://... (port 80) or https://... (port 443)
    v
 Google VPC firewall: tcp 22, 80, 443 only (runs outside the VM)
    |
    v
 +- VM "devops": only Docker is installed -------------------------------------------+
 |                                                                                   |
 |  proxy  nginx:1.30.5-alpine3.24, the ONLY container that publishes ports (80, 443)      |
 |    |-- /      --> frontend:8080  nginx-unprivileged, the built Vite pages         |
 |    '-- /api/  --> backend:3000   Express API                                      |
 |                     '--> db:5432  postgres 17, internal network "data"            |
 |                                                                                   |
 |  certbot (one-off, stage 3+) --writes--> volume letsencrypt --read-only--> proxy  |
 +-----------------------------------------------------------------------------------+
```

- **One way in.** Only the proxy publishes ports. The other containers talk over private Docker
  networks, and the database's network (`data`, `internal: true`) has no route to the internet at all.
- **No web server on the host.** nginx and certbot are containers too; the VM itself only runs Docker
  (and SSH). The proxy picks its own config at every start: HTTP-only until a certificate exists,
  HTTPS after that ([`select-site-config.sh`](deploy/nginx/select-site-config.sh)).
- **The firewall sits outside the VM.** Docker's published ports bypass a host firewall such as
  `ufw`, so the VM has none: Google's VPC firewall is the real gate.

### 5.3 Ports

| Port | Listener | Published on the VM? | Reachable by |
|------|----------|----------------------|--------------|
| 80 | proxy | **yes** | the internet: the app in stages 1-2; from Stage 3 the redirect to HTTPS, `/healthz` and Let's Encrypt challenges |
| 443 | proxy | **yes** | the internet: the app, from Stage 3 on |
| 8080 | frontend | no | the proxy, over the `edge` network |
| 3000 | backend | no | the proxy and the frontend, over `edge` |
| 5432 | db | no | the backend only, over the internal `data` network |
| 22 | sshd on the VM (not Docker) | - | you, the CI deploy job (Stage 4) and Ansible (Stage 5) |

Check it from your laptop: `curl -m 5 http://<VM-IP>:3000/api/health` must time out.

### 5.4 Environments at a glance

|  | Local dev | CI (`ci-test.yml`) | Production |
|--|-----------|--------------------|------------|
| Compose file | `docker-compose.yml` | `docker-compose.prod.yml` | `docker-compose.prod.yml` |
| Project name | `bugsquash-dev` | `bugsquash` | `bugsquash` |
| Images | built locally (`dev` targets) | built in the job (`production`), tagged `local/bugsquash-*:ci` | pulled from Docker Hub: `<user>/bugsquash-*:<tag>` |
| Settings | `.env` (optional) | a throwaway `.env.prod` with random secrets | `.env.prod` (`chmod 600`), master copy on your laptop |
| Source code | bind-mounted, hot reload | baked into the image | baked into the image |
| Entry URL | http://localhost:5173 | http://localhost, then https://localhost | https://devops.gulfheight.com |
| Published ports | 5173, 3000, 5432 (on `127.0.0.1`) | 80, 443 | 80, 443 |

### 5.5 Everyday commands on the VM

```bash
cd /opt/devops-workshop
alias dc='docker compose -f docker-compose.prod.yml --env-file .env.prod'
dc ps                                     # state + health of each container
dc logs -f --tail=100 backend             # follow the backend's output
dc exec db psql -U bugsquash bugsquash    # SQL shell (the db port is not published)
docker stats --no-stream                  # memory against the cgroup limits
./deploy/tls.sh status                    # certificate and proxy mode (Stage 3+)
./deploy/deploy.sh sha-1a2b3c4            # deploy or roll back to an exact build (Stage 4+)
```

## Part 6: Troubleshooting

**Local development**

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `Bind for 127.0.0.1:5432 failed: port is already allocated` | a local Postgres or another stack uses the port | find it with `sudo ss -ltnp 'sport = :5432'` (Linux) or `lsof -i :5432` (macOS); set `POSTGRES_HOST_PORT=5433` in `.env`. Same idea for 3000, 5173, and for 80 in the rehearsal (2.6) |
| Edits are not picked up (macOS / Windows) | file events do not cross Docker Desktop's VM | `VITE_USE_POLLING=true docker compose up` |
| Vite fails after changing `package.json` | the anonymous `node_modules` volume holds the old dependencies | `docker compose up --build --renew-anon-volumes` |
| backend logs `password authentication failed for user "bugsquash"` | `POSTGRES_PASSWORD` changed after the volume was created | dev: `docker compose down -v && docker compose up --build` (deletes local data) |
| `permission denied while trying to connect to the Docker daemon socket` | your user is not in the `docker` group yet | `sudo usermod -aG docker $USER`, then log out and back in |
| `429` "Too many attempts. The bugs need a break too" | auth rate limit (30 per 15 min per IP) | wait, raise `AUTH_RATE_LIMIT_MAX` in `.env`, or `docker compose restart backend` |

**CI/CD**

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| CD (main): `Username and password required` at "Log in to Docker Hub" | Docker Hub secrets missing, misspelled, or created as *variables* | add `DOCKER_HUB_USERNAME` and `DOCKER_HUB_ACCESS_TOKEN` as repository **secrets** |
| CD (main): `denied: requested access to the resource is denied` | read-only token, or a token from another account | create a **Read & Write** token for the same account |
| CI (dev): hadolint or shellcheck fails | a best-practice rule such as `DL3018` or `SC2086` | fix it, or add a justified `# hadolint ignore=DLxxxx` above the line |
| CI (test): "runs as root" | a Dockerfile lost its non-root `USER` line | restore `USER 1000:1000` (backend) / `USER 101` (frontend) |
| CI (test): a deploy step fails | a container crashed or a healthcheck failed | read the "Dump container state and logs" step |
| Deploy job fails (SSH, host key, rsync) | Stage 4 setup | [Stage 4 troubleshooting](deploy/stage-4-automated-deploys.md#troubleshooting) |

**On the server**

| You are stuck at... | Look here |
|---------------------|-----------|
| creating the VM, SSH, installing Docker, the first `up -d` | [Stage 1 troubleshooting](deploy/stage-1-ip-http.md#troubleshooting) |
| the DNS record, `dig` | [Stage 2 troubleshooting](deploy/stage-2-domain-http.md#troubleshooting) |
| certbot, the redirect, the padlock, renewals | [Stage 3 troubleshooting](deploy/stage-3-https.md#troubleshooting) |
| `deploy.sh`, the CI deploy, rollbacks | [Stage 4 troubleshooting](deploy/stage-4-automated-deploys.md#troubleshooting) |
| firewall rules, the static IP, quotas, costs | [Google Cloud reference](deploy/gcp-vm-setup.md#troubleshooting) |

A few symptoms that can appear in any stage:

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| **502 Bad Gateway** from nginx | backend or frontend down or still starting | `dc ps`, `dc logs --tail=100 backend proxy` (the `dc` alias from 5.5) |
| `/api/health` returns **503** `{"status":"error"}` | the backend cannot reach Postgres: it is unhealthy, or `POSTGRES_PASSWORD` no longer matches the volume | `dc logs backend db` (the reason is logged there, never shown publicly); after changing the password, also run `ALTER USER` in psql |
| Login does not stick (you bounce back to the login page) | `COOKIE_SECURE=true` while the site is still plain HTTP | `COOKIE_SECURE=false` until Stage 3 ([Stage 1, step 5](deploy/stage-1-ip-http.md#5-create-envprod-on-your-laptop)) |
| `pull access denied` or `manifest unknown` | wrong `DOCKER_HUB_USERNAME`, or that tag was never pushed | check the tags on Docker Hub |
| `exec format error` | image built for another CPU (for example pushed by hand from a laptop) | let CD (main) build it: it builds amd64 and arm64 |

## API reference

All requests and responses are JSON; errors look like `{"error": "<message>"}`. Auth uses the
**`bugsquash_token`** cookie: a JWT `{sub: userId, username}`, `HttpOnly`, `SameSite=Lax`, `Path=/`,
`Secure` when `COOKIE_SECURE=true`, and `Max-Age` equal to the JWT lifetime.

| Method | Path | Auth | Request body | Success | Errors |
|--------|------|------|--------------|---------|--------|
| `GET` | `/api/health` | none | | `200 {"status":"ok","version":"<APP_VERSION>"}` (200 means the database answered too) | `503 {"status":"error","version":"<APP_VERSION>"}` (reason only in `docker compose logs backend`) |
| `POST` | `/api/auth/signup` | none, rate-limited | `{"username","password"}` | `201 {"user":{"id","username"}}` + `Set-Cookie` | `400` invalid input, `409` username taken, `429` |
| `POST` | `/api/auth/login` | none, rate-limited | `{"username","password"}` | `200 {"user":{"id","username"}}` + `Set-Cookie` | `400` missing fields, `401 {"error":"Invalid username or password"}`, `429` |
| `POST` | `/api/auth/logout` | none | | `204`, cookie cleared | |
| `GET` | `/api/auth/me` | cookie | | `200 {"user":{"id","username"}}` | `401` |
| `POST` | `/api/scores` | cookie | `{"score": 42}` | `201 {"score":{"id","score","createdAt"}}` | `400` not a non-negative integer, `401`, **`422` score > 200** (anti-cheat) |
| `GET` | `/api/scores/me` | cookie | | `200 {"best","gamesPlayed","recent":[{"id","score","createdAt"}]}` (latest 10, newest first) | `401` |
| `GET` | `/api/scores/leaderboard` | none | | `200 {"leaderboard":[{"rank","username","best"}]}`: top 10 by best score; ties share a rank (SQL `RANK()`) | |
| any | `/api/<unknown>` | | | | `404 {"error":"Not found"}` |

Validation rules:

- **Usernames:** 3-20 characters of `[a-zA-Z0-9_]`, unique case-insensitively (unique index on
  `LOWER(username)`).
- **Passwords:** 8-72 characters and at most 72 bytes (bcrypt ignores anything longer), hashed with
  bcryptjs at cost 10.
- **Scores:** integers from 0 to **200** (`MAX_SCORE`), checked on the server.
- **Requests:** malformed JSON gets `400`, bodies over 10 kB get `413`.
- **Rate limit:** signup and login allow `AUTH_RATE_LIMIT_MAX` requests (default 30) per 15 minutes
  per IP.

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

## Environment variables

| Variable | Used by | Dev default (`docker-compose.yml`) | Production (`.env.prod`) | Notes |
|----------|---------|------------------------------------|--------------------------|-------|
| `DOCKER_HUB_USERNAME` | prod compose image names | | **required** | `alhuraibisaeed` for the course images, or your own account (Part 4) |
| `IMAGE_TAG` | prod compose | | `latest` | `./deploy/deploy.sh <tag>` overrides it for one deploy |
| `DOMAIN` | proxy, `tls.sh` | | empty in Stage 1, then `devops.gulfheight.com` | the certificate is requested for exactly this name |
| `LETSENCRYPT_EMAIL` | `tls.sh` | | optional | empty = register without an e-mail address |
| `POSTGRES_DB` | db; backend as `PGDATABASE` | `bugsquash` | `bugsquash` | applied when the volume is first created |
| `POSTGRES_USER` | db; backend as `PGUSER` | `bugsquash` | `bugsquash` | applied when the volume is first created |
| `POSTGRES_PASSWORD` | db; backend as `PGPASSWORD` | `bugsquash-dev-password` | **required** (`openssl rand -hex 32`) | changing it later also needs `ALTER USER` |
| `POSTGRES_HOST_PORT` | dev compose only | `5432` | | host port for psql or GUI clients |
| `JWT_SECRET` | backend | `dev-only-insecure-secret-change-me` | **required** | rotating it logs everyone out |
| `JWT_EXPIRES_IN` | backend | `7d` | `7d` | `60s`, `15m`, `12h`, `7d`; a bare number means seconds |
| `COOKIE_SECURE` | backend | `false` | `false` in stages 1-2, `true` from Stage 3 | `true` = the cookie travels over HTTPS only |
| `AUTH_RATE_LIMIT_MAX` | backend | `30` | `30` | signup and login attempts per IP per 15 min |
| `APP_VERSION` | backend | `dev` | *not set*: baked into the image by CI (short SHA) | shown in `/api/health` and the footer |
| `VITE_APP_VERSION` | frontend build arg | `dev` | baked in by CI (short SHA) | shown in the footer as "Web" |
| `VITE_USE_POLLING` | Vite dev server | `false` | | `true` on Docker Desktop if hot reload misses edits |
| `VITE_API_PROXY_TARGET` | Vite dev server | `http://backend:3000` (set by compose) | | `vite.config.js` falls back to `http://localhost:3000` |

Set by the Compose files, not by you: `NODE_ENV`, `PORT=3000`, `PGHOST=db`, `PGPORT=5432`.

Tool-only variables:

- integration tests: `BASE_URL` (default `http://localhost`, the production stack's proxy) and
  `API_ONLY=1` when `BASE_URL` is the bare API;
- `deploy/deploy.sh`: `WAIT_TIMEOUT` (180 s), `LOCK_TIMEOUT` (300 s), `NO_COLOR`, `SKIP_PULL=1`;
- `deploy/tls.sh`: `FORCE=1` (skip the DNS check), `LOCK_TIMEOUT` (600 s), `NO_COLOR`.

## Make it your own

**Warm-up: follow one change all the way to production**

1. Add a rank title in `app/frontend/src/js/ranks.js`, or change the anti-cheat message in
   `app/backend/src/validation.js`. Watch hot reload pick it up.
2. Push to `dev` and promote it `dev -> test -> main`. Watch all three workflows run.
3. Find the new short SHA in the footer and in `/api/health`, then roll back with
   `./deploy/deploy.sh sha-<previous>` and watch the footer change back.

**Containers and Linux** (pair these with [the theory chapter](docs/containers-deep-dive.md))

Use the local production rehearsal from [2.6](#26-rehearse-the-production-stack-locally-optional)
with `alias dc='docker compose -f docker-compose.prod.yml --env-file .env.ci'`.

- **PID 1 and signals.** Comment out the two `process.on('SIGTERM' / 'SIGINT')` lines in
  `app/backend/src/server.js`, rebuild, and run `time dc stop backend`. Explain the 10 seconds and
  `docker inspect -f '{{.State.ExitCode}}' bugsquash-backend-1` (137) with PID 1 and SIGKILL.
- **cgroups.** Lower the backend memory limit to `32M`, watch `docker stats`, and check
  `docker inspect -f '{{.State.OOMKilled}}' bugsquash-backend-1`.
- **Network isolation.** Run `dc exec frontend wget -T 3 -O- http://db:5432`, then the same from the
  backend. Explain the difference with `docker network inspect bugsquash_data`.
- **Read-only root filesystem.** `dc exec backend touch /home/node/x` fails although `node` owns that
  folder, while `dc exec backend touch /tmp/x` works. Explain both with overlay layers and tmpfs.
- **Two users in one container.** `dc exec proxy ps -o user,args` shows a root master and `nginx`
  workers. Why does the proxy need both (hint: certbot's private keys are `0600`)?

**Features (touch every layer: API, unit test, integration test, UI)**

- Add `GET /api/scores/stats` (total games, total bugs squashed) and show it on the landing page.
- Add a "daily leaderboard" (`WHERE created_at > now() - interval '1 day'`). Which index does it need?
- Move the round length (`ROUND_MS` in `game.js`) into server-provided config, and make the
  anti-cheat limit depend on it.

**DevOps stretch goals**

- **Backups.** `ansible/backup.yml` already copies the database and the certificate to your laptop.
  Run it on a schedule, keep copies in a Cloud Storage bucket, and practise a **restore**.
- **Security scanning.** Add Trivy or Docker Scout to `ci-test.yml` and fail on critical CVEs; enable
  Dependabot for npm, GitHub Actions and Dockerfiles; pin actions by commit SHA.
- **Monitoring.** Point an uptime checker (for example Uptime Kuma) at `/api/health`; add a
  Prometheus `/metrics` endpoint and a Grafana dashboard.
- **Staging.** Deploy the `test` branch to `staging.devops.gulfheight.com` on a second VM (with
  Ansible that is one command).
- **Zero-downtime deploys.** Run two backend replicas (blue/green) behind the proxy and switch between
  them. The in-memory rate limiter then needs a shared store such as Redis.
- **Edge rate limiting.** Add nginx `limit_req` for `/api/auth/` in
  [`deploy/nginx/snippets/`](deploy/nginx/snippets/) and compare it with the app's own limiter.
- **Cloudflare orange cloud.** Follow the *Going deeper* box in [Stage 3](deploy/stage-3-https.md) and
  check that the rate limiter still sees real client IPs.

**Use your own domain.** The name lives in settings, not in code:

1. your DNS A record ([Stage 2](deploy/stage-2-domain-http.md));
2. `DOMAIN` in `.env.prod`, and the `-d` of the certbot command ([Stage 3](deploy/stage-3-https.md));
3. the GitHub variable `SITE_URL` ([Stage 4](deploy/stage-4-automated-deploys.md));
4. `domain` and `cloudflare_zone` in `ansible/group_vars/all.yml` (Stage 5).

Then `grep -rn "gulfheight" --exclude-dir=node_modules .` finds the remaining mentions, which are
examples in comments and docs.
