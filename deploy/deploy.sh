#!/usr/bin/env bash
# =============================================================================
# deploy/deploy.sh - pull and (re)start Bug Squash Arena on the production server
# -----------------------------------------------------------------------------
# Usage (on the Google Cloud VM, as the user that owns /opt/devops-workshop -
# your own admin login while you work by hand, the "deploy" user once CI
# deploys for you):
#
#   cd /opt/devops-workshop
#   ./deploy/deploy.sh                 # deploy IMAGE_TAG from .env.prod ("latest")
#   ./deploy/deploy.sh sha-1a2b3c4     # deploy - or ROLL BACK to - an exact build
#   ./deploy/deploy.sh --help
#
# It runs from the DEPLOY BUNDLE - the server has no Git checkout:
#
#   /opt/devops-workshop/
#     docker-compose.prod.yml   what to run
#     deploy/                   this script, tls.sh, nginx/ (proxy config), systemd/
#     .env.prod                 secrets + settings (0600; copied by you with scp,
#                               or rendered by Ansible in stage 5)
#
# Who calls it (stage 4 of the workshop; stages 1-3 use a plain
# `docker compose ... up -d` - this script runs the same command, plus checks):
#   * you, by hand: after copying a new bundle, or for a rollback;
#   * the optional deploy job in .github/workflows/ci-main.yml, which rsyncs
#     the bundle (docker-compose.prod.yml + deploy/) from its checkout and
#     then runs, over SSH:
#       cd /opt/devops-workshop && ./deploy/deploy.sh sha-<short>
#   * Ansible (stage 5, ansible/provision.sh) after copying the bundle.
#
# What happens, step by step (every step is idempotent: re-running is safe):
#
#   1. Pre-flight  : docker + compose plugin present, daemon reachable, .env.prod
#                    present, nobody else deploying at the same moment.
#   2. Validate    : render docker-compose.prod.yml with .env.prod. Missing
#                    settings (${VAR:?...}) abort HERE, before anything changes.
#   3. Pull        : download the new images. Only layers that changed are
#                    transferred - image LAYERS are content-addressed, so the
#                    node:24-alpine base layers are already on disk.
#   4. Up          : recreate only the containers whose image or config
#                    changed, then WAIT until their healthchecks pass.
#   5. Proxy config: re-render the edge proxy's site config from the templates
#                    in deploy/nginx/ and reload nginx GRACEFULLY (picks up
#                    config changes from this bundle, zero dropped connections).
#   6. Smoke test  : each container from the inside, then the full path
#                    through the proxy exactly as a visitor would take it.
#   7. Clean up    : delete dangling images so the disk does not fill up.
#   8. Status      : print what is running now.
#
# Certificates are NOT handled here - that is deploy/tls.sh (and its systemd
# timer). This script works in both proxy modes: HTTP-only (no certificate yet)
# and HTTPS; it detects which one is active and tests accordingly.
#
# Why a script and not just two commands? Because a deploy is a procedure, and
# procedures that live in someone's head are executed differently every time.
# A script is the same on every run, for humans, for Ansible and for CI.
#
# Optional environment variables:
#   WAIT_TIMEOUT   seconds to wait for healthy containers (default: 180)
#   LOCK_TIMEOUT   seconds to wait if another deploy or a certificate renewal
#                  holds the lock (default: 300)
#   NO_COLOR       set to anything to disable colored output (https://no-color.org)
#   SKIP_PULL=1    rehearsal mode: do NOT pull from Docker Hub, run the images
#                  already on this machine (e.g. built locally as
#                  local/bugsquash-*:ci, like the ci-test workflow does), and
#                  skip the image prune. Never needed on the real server.
#                  Example, on your laptop (from the repository root):
#                    docker build --target production -t local/bugsquash-backend:ci app/backend
#                    docker build --target production -t local/bugsquash-frontend:ci app/frontend
#                    docker pull nginx:1.27-alpine && docker pull postgres:17-alpine
#                    # .env.prod with DOCKER_HUB_USERNAME=local, DOMAIN=localhost,
#                    # COOKIE_SECURE=false and two `openssl rand -hex 32` secrets
#                    SKIP_PULL=1 ./deploy/deploy.sh ci
#
# Exit codes: 0 = deployed and smoke-tested, 1 = failed (see the message),
#             2 = wrong usage.
# =============================================================================

# -E : ERR trap is inherited by functions (so on_error below fires everywhere)
# -e : exit on the first failing command      -u : unset variable = error
# -o pipefail : a pipeline fails if ANY command in it fails, not just the last
set -Eeuo pipefail

# ---- Pretty output ----------------------------------------------------------
# Colors only when stdout is a terminal. When CI or Ansible capture the output
# over SSH, raw escape codes would just make the log unreadable.
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_RESET=$'\033[0m'  C_BOLD=$'\033[1m'   C_DIM=$'\033[2m'
  C_RED=$'\033[31m'   C_GREEN=$'\033[32m' C_YELLOW=$'\033[33m' C_BLUE=$'\033[34m'
else
  C_RESET='' C_BOLD='' C_DIM='' C_RED='' C_GREEN='' C_YELLOW='' C_BLUE=''
fi

readonly TOTAL_STEPS=8
step() { printf '\n%s==> [%s/%s] %s%s\n' "${C_BOLD}${C_BLUE}" "$1" "$TOTAL_STEPS" "$2" "$C_RESET"; }
info() { printf '  %s->%s %s\n' "$C_DIM" "$C_RESET" "$*"; }
ok()   { printf '  %s[ok]%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '  %s[warn] %s%s\n' "$C_YELLOW" "$*" "$C_RESET" >&2; }
die()  { printf '\n  %s[fail] %s%s\n' "${C_BOLD}${C_RED}" "$*" "$C_RESET" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: ./deploy/deploy.sh [IMAGE_TAG]

Pulls the Bug Squash Arena images from Docker Hub and (re)starts the production
stack defined in docker-compose.prod.yml, using settings from .env.prod. Run it
from anywhere; it always works in the bundle directory it lives in.

  IMAGE_TAG   optional, e.g. "latest" or "sha-1a2b3c4". Overrides IMAGE_TAG
              from .env.prod for this deploy only. Use an older sha-* tag to
              roll back.

Environment: WAIT_TIMEOUT (default 180 s), LOCK_TIMEOUT (default 300 s), NO_COLOR,
             SKIP_PULL=1 (use local images, no pull/prune - for rehearsals).
Exit codes:  0 deployed, 1 failed, 2 wrong usage.
EOF
}

# Safety net: if any command fails unexpectedly (set -e), say WHERE before
# exiting, instead of dying silently in the middle of a CI log.
on_error() {
  local exit_code=$? line=$1
  printf '\n  %s[fail] deploy aborted (exit %s) at line %s: %s%s\n' \
    "${C_BOLD}${C_RED}" "$exit_code" "$line" "$BASH_COMMAND" "$C_RESET" >&2
  exit "$exit_code"
}
trap 'on_error $LINENO' ERR

# The two files every production compose command needs (relative to the bundle root).
readonly COMPOSE_FILE_PATH="docker-compose.prod.yml"
readonly ENV_FILE_PATH=".env.prod"

# ---- Arguments ----------------------------------------------------------------
# Where the image tag comes from - only used to print a helpful message.
if [[ -n "${IMAGE_TAG:-}" ]]; then
  tag_source="your shell environment (overrides $ENV_FILE_PATH)"
else
  tag_source="$ENV_FILE_PATH (or 'latest' if it is not set there)"
fi

if [[ $# -gt 1 ]]; then
  usage >&2
  exit 2
fi
if [[ $# -eq 1 ]]; then
  case "$1" in
    -h | --help) usage; exit 0 ;;
    *) ;; # anything else is an image tag, validated next
  esac
  # Docker's tag grammar: [A-Za-z0-9_][A-Za-z0-9_.-]{0,127}. Validating it here
  # also guarantees nothing odd ever reaches a command line.
  if [[ ! "$1" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; then
    printf "Invalid image tag '%s' (allowed: letters, digits, '_', '.', '-'; max 128 chars).\n\n" "$1" >&2
    usage >&2
    exit 2
  fi
  # Compose's interpolation precedence: variables from the SHELL ENVIRONMENT
  # beat values from --env-file. Exporting IMAGE_TAG therefore overrides the
  # IMAGE_TAG line in .env.prod for this run only - .env.prod stays untouched.
  export IMAGE_TAG="$1"
  tag_source="the command line (overrides $ENV_FILE_PATH)"
fi

readonly WAIT_TIMEOUT="${WAIT_TIMEOUT:-180}"
[[ "$WAIT_TIMEOUT" =~ ^[0-9]+$ ]] || die "WAIT_TIMEOUT must be a whole number of seconds (got '$WAIT_TIMEOUT')."

readonly LOCK_TIMEOUT="${LOCK_TIMEOUT:-300}"
[[ "$LOCK_TIMEOUT" =~ ^[0-9]+$ ]] || die "LOCK_TIMEOUT must be a whole number of seconds (got '$LOCK_TIMEOUT')."

readonly SKIP_PULL="${SKIP_PULL:-0}"
[[ "$SKIP_PULL" =~ ^[01]$ ]] || die "SKIP_PULL must be 0 or 1 (got '$SKIP_PULL')."

# ---- Locate the bundle --------------------------------------------------------
# Resolve paths from the script's OWN location, not from the caller's current
# directory, so "./deploy/deploy.sh", "deploy.sh" (from inside deploy/) and an
# absolute path from Ansible, systemd or CI all behave the same. The bundle
# root is the parent of deploy/ - /opt/devops-workshop on the server, the
# repository root on your laptop.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
BUNDLE_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
readonly SCRIPT_DIR BUNDLE_ROOT
cd -- "$BUNDLE_ROOT"

# Every compose call goes through this wrapper, so the file, the env file and
# the project directory can never accidentally differ between steps. The
# project NAME ("bugsquash") comes from the `name:` key inside the file.
compose() {
  docker compose \
    --project-directory "$BUNDLE_ROOT" \
    -f "$COMPOSE_FILE_PATH" \
    --env-file "$ENV_FILE_PATH" \
    "$@"
}

# Read one service's running image reference, e.g. "alice/bugsquash-backend:sha-1a2b3c4".
# Prints nothing if the service is not running (first deploy).
running_image() {
  local cid
  cid="$(compose ps -q "$1" 2>/dev/null || true)"
  [[ -n "$cid" ]] || return 0
  docker inspect --format '{{.Config.Image}}' "$cid" 2>/dev/null || true
}

printf '%sBug Squash Arena - production deploy%s  %s(bundle: %s)%s\n' \
  "$C_BOLD" "$C_RESET" "$C_DIM" "$BUNDLE_ROOT" "$C_RESET"

# =============================================================================
step 1 "Pre-flight checks"
# =============================================================================
command -v docker >/dev/null 2>&1 \
  || die "docker not found. Install Docker Engine first (stage 1: the docker.com apt instructions for Debian; stage 5: ./ansible/provision.sh from your laptop)."

docker compose version >/dev/null 2>&1 \
  || die "The Docker Compose v2 plugin is missing ('docker compose'). Install the docker-compose-plugin package."

# `docker info` talks to the daemon over /var/run/docker.sock. It fails if the
# daemon is down OR if this user may not open the socket (not in the docker group).
docker info >/dev/null 2>&1 \
  || die "Cannot reach the Docker daemon. Is it running (systemctl status docker)? Is '$(id -un)' in the 'docker' group (by hand: sudo usermod -aG docker $(id -un), then log out and back in; Ansible adds 'deploy')?"

command -v curl >/dev/null 2>&1 || die "curl not found (sudo apt install curl)."

[[ -f "$COMPOSE_FILE_PATH" ]] || die "$COMPOSE_FILE_PATH not found in $BUNDLE_ROOT - is the deploy bundle complete?"
[[ -d deploy/nginx/templates ]] || die "deploy/nginx/templates/ not found in $BUNDLE_ROOT - the proxy has no config. Copy the bundle again (scp -r deploy/nginx ..., the CI deploy job, or ansible/provision.sh)."
[[ -f "$ENV_FILE_PATH" ]] \
  || die "$ENV_FILE_PATH not found in $BUNDLE_ROOT. Create it on your laptop (cp .env.prod.example .env.prod, fill in every REQUIRED value), scp it here and chmod 600 it. (Stage 5: Ansible renders it from the vault.) The CI deploy job never copies it - secrets stay on the server."

# .env.prod holds the database password and the JWT signing secret. The last
# digit of the octal mode is "others": anything but 0 means every account on
# this server can read our secrets. (GNU stat syntax - this runs on Debian.)
env_mode="$(stat -c '%a' "$ENV_FILE_PATH" 2>/dev/null || true)"
if [[ -n "$env_mode" && "${env_mode: -1}" != "0" ]]; then
  warn "$ENV_FILE_PATH is readable by other users (mode $env_mode). Fix: chmod 600 $ENV_FILE_PATH"
fi

# One deploy at a time. A human deploying by hand while CI deploys the next
# commit would race, and so would a certificate renewal (deploy/tls.sh takes
# the same lock). flock(1) takes an exclusive lock on the bundle directory
# (file descriptor 9 stays open until the script exits, and so does the lock;
# the kernel releases it automatically even if we crash).
if command -v flock >/dev/null 2>&1; then
  exec 9<"$BUNDLE_ROOT"
  if ! flock -n 9; then
    info "Another deploy or a certificate renewal is running - waiting up to ${LOCK_TIMEOUT}s for it to finish..."
    flock -w "$LOCK_TIMEOUT" 9 || die "Still locked after ${LOCK_TIMEOUT}s (another deploy.sh or tls.sh in $BUNDLE_ROOT). Try again later."
  fi
else
  warn "flock not found (util-linux) - skipping the concurrent-deploy lock."
fi

ok "$(docker --version)"
ok "$(docker compose version)"
ok "$ENV_FILE_PATH found"

# =============================================================================
step 2 "Validating ${COMPOSE_FILE_PATH} + ${ENV_FILE_PATH}"
# =============================================================================
# `config -q` interpolates every ${VAR} and validates the result without
# printing it (the rendered output would contain the secrets). A missing
# REQUIRED variable fails right here, while the old version is still serving.
compose config -q || die "Compose configuration is invalid - see the message above (missing setting in $ENV_FILE_PATH?)."

info "IMAGE_TAG comes from ${tag_source}"
info "Images that will run:"
compose config --images | sed 's/^/       /'

# Remember what is running NOW, so a failed deploy can print a one-line rollback.
previous_backend_image="$(running_image backend)"
if [[ -n "$previous_backend_image" ]]; then
  info "Currently running backend: $previous_backend_image"
else
  info "No backend running yet - this looks like a first deploy."
fi
ok "Configuration is valid"

# =============================================================================
step 3 "Pulling images from Docker Hub"
# =============================================================================
# Pulling BEFORE `up` keeps downtime short: the slow network transfer happens
# while the old containers are still serving traffic. Note "Already exists"
# in the output - that is layer caching at work. (The certbot image belongs to
# the "tools" profile and is not pulled here; deploy/tls.sh pulls it on first use.)
if [[ "$SKIP_PULL" == "1" ]]; then
  # Rehearsal mode: the images were built on this machine and do not exist on
  # Docker Hub, so a pull would fail. Check they are all present instead, so
  # `up` below does not silently try to pull a missing one.
  warn "SKIP_PULL=1: not pulling - using images already on this machine."
  while read -r image; do
    docker image inspect "$image" >/dev/null 2>&1 \
      || die "SKIP_PULL=1 but image '$image' is not on this machine. Build or pull it first."
    ok "local image present: $image"
  done < <(compose config --images)
else
  # A failed pull aborts HERE, before any running container is touched: the
  # old version keeps serving. Typical causes: the tag was never pushed (CI
  # still running?), a typo in DOCKER_HUB_USERNAME, or a private repository
  # without `docker login`.
  compose pull \
    || die "Pulling the images failed - nothing was changed. Does tag '${IMAGE_TAG:-<from $ENV_FILE_PATH>}' exist on Docker Hub? (private repo: docker login first)"
  ok "Images pulled"
fi

# =============================================================================
step 4 "Starting containers and waiting for healthchecks (timeout ${WAIT_TIMEOUT}s)"
# =============================================================================
# up -d             : start in the background (detached).
# --remove-orphans  : remove containers of services that were deleted from the
#                     compose file, so they don't linger with stale code.
# --wait            : block until every service is "running" and its HEALTHCHECK
#                     reports "healthy" - otherwise exit non-zero.
#
# Compose only RECREATES a container if its image digest or its configuration
# changed. Recreating = stop the old container (Docker sends SIGTERM to the
# container's PID 1, then SIGKILL after stop_grace_period - that is why our
# Node backend handles SIGTERM itself and why its CMD is ["node", ...] in
# exec form, so node really IS PID 1 and receives the signal) and start a new
# one from the new image. Named volumes (database, certificates) are NOT touched.
# The proxy keeps running and finds the new backend by itself: it re-resolves
# "backend" through Docker's DNS every few seconds.
#
# Expect a few seconds of API errors per recreated container. Zero-downtime
# deploys (blue/green, rolling updates) need a second copy of the service and a
# load balancer that switches between them - a good follow-up exercise.
if ! compose up -d --remove-orphans --wait --wait-timeout "$WAIT_TIMEOUT"; then
  printf '\n' >&2
  warn "Containers did not become healthy. Current state:"
  compose ps -a >&2 || true
  warn "Last 40 log lines per service:"
  compose logs --no-color --tail=40 >&2 || true
  # ${var##*:} strips everything up to the last ":" => just the tag.
  previous_tag="${previous_backend_image##*:}"
  if [[ -n "$previous_backend_image" && "$previous_tag" != "latest" && "$previous_tag" != "${IMAGE_TAG:-}" ]]; then
    warn "To roll back to the previous build run:  ./deploy/deploy.sh ${previous_tag}"
  elif [[ -n "$previous_backend_image" ]]; then
    # "latest" is a MOVING tag: after this pull it already points to the new
    # build, so it cannot take you back. That is why CI deploys sha-* tags.
    warn "Roll back by deploying the previous immutable tag: ./deploy/deploy.sh sha-<previous-commit> (see Docker Hub or the GitHub Actions history)."
  fi
  die "Deploy failed: services are not healthy."
fi
ok "All services are up and healthy"

# =============================================================================
step 5 "Refreshing the edge proxy configuration (graceful reload)"
# =============================================================================
# The proxy renders its site config from deploy/nginx/templates/ only when the
# container STARTS (the official image's entrypoint does it). A deploy that
# brings new proxy config - a new security header, a Cloudflare IP range - does
# not change the proxy's image or compose settings, so `up` above leaves the
# container alone. So we re-run the same two start-up steps inside the
# running container and RELOAD nginx:
#   select-site-config.sh         pick HTTPS or HTTP-only (is there a certificate?)
#                                 - deploy/nginx/ is mounted at /etc/nginx/bugsquash/
#   20-envsubst-on-templates.sh   the image's own script: render the template
#                                 into conf.d/site.conf
#   nginx -t                      validate; on error STOP - the running nginx
#                                 keeps serving its old config from memory
#   nginx -s reload               new workers with the new config; old workers
#                                 finish their in-flight requests, then exit.
#                                 Zero dropped connections.
# (Snippets in deploy/nginx/snippets/ are read on every reload anyway.)
if ! compose exec -T proxy sh -c \
  '. /etc/nginx/bugsquash/select-site-config.sh && /docker-entrypoint.d/20-envsubst-on-templates.sh && nginx -t -q && nginx -s reload'; then
  compose logs --no-color --tail=20 proxy >&2 || true
  die "The proxy configuration from this bundle is invalid (see 'nginx -t' above). nginx is still serving the PREVIOUS config; fix deploy/nginx/ and deploy again."
fi

# Which mode is the proxy in now? Ask the running proxy itself: the HTTPS
# config is the one with a `listen 443` (select-site-config.sh chose it
# because a certificate for DOMAIN exists in the letsencrypt volume).
# DOMAIN is read from the running proxy too: that is the value nginx really
# uses. It may be EMPTY in stage 1 (the site is served on the bare IP).
DOMAIN="$(compose exec -T proxy printenv DOMAIN 2>/dev/null | tr -d '\r' || true)"
if [[ -n "$DOMAIN" && ! "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]]; then
  die "The proxy's DOMAIN ('$DOMAIN') is not a valid host name - check DOMAIN in $ENV_FILE_PATH (no http://, no slash)."
fi
# (The regex matches a real `listen 443` directive, never a comment.)
if compose exec -T proxy grep -Eq '^[[:space:]]*listen[[:space:]]+443' /etc/nginx/conf.d/site.conf; then
  proxy_mode="https"
  ok "Proxy reloaded - HTTPS mode (certificate for ${DOMAIN} found)"
elif [[ -z "$DOMAIN" ]]; then
  proxy_mode="http-only"
  ok "Proxy reloaded - HTTP-only mode, DOMAIN is empty (stage 1: the site answers on the server's IP)"
else
  proxy_mode="http-only"
  ok "Proxy reloaded - HTTP-only mode (no certificate for ${DOMAIN} yet)"
  info "Get one with: ./deploy/tls.sh issue   (or the certbot command from stage 3)"
fi

# COOKIE_SECURE must match the mode, or logins break (HTTP) or are less safe
# (HTTPS). Read the value the running backend really got.
# (The backend accepts only "true"/"false"; empty means true in production.)
cookie_secure="$(compose exec -T backend printenv COOKIE_SECURE 2>/dev/null | tr -d '\r' || true)"
cookie_secure="${cookie_secure,,}"   # ,, = lower-case (bash 4+)
cookie_secure="${cookie_secure:-true}"
if [[ "$proxy_mode" == "http-only" && "$cookie_secure" == "true" ]]; then
  warn "COOKIE_SECURE=${cookie_secure} but the site is served over plain HTTP: browsers will DROP the login cookie and logins won't stick. Set COOKIE_SECURE=false in $ENV_FILE_PATH until HTTPS works (stage 3), then deploy again."
elif [[ "$proxy_mode" == "https" && "$cookie_secure" == "false" ]]; then
  warn "COOKIE_SECURE=${cookie_secure} although HTTPS is active: the login cookie could leak over plain http://. Set COOKIE_SECURE=true in $ENV_FILE_PATH and deploy again."
else
  ok "COOKIE_SECURE=${cookie_secure} fits the ${proxy_mode} mode"
fi

# =============================================================================
step 6 "Smoke tests (inside each container, then through the proxy)"
# =============================================================================
# The containers being "healthy" is what Docker thinks. The smoke tests check
# the request path piece by piece, so a failure points at the broken hop:
#   a) each app container from the INSIDE (docker compose exec ... wget) -
#      only the proxy publishes ports, so this is how we reach them directly;
#   b) through the proxy on the host's ports 80/443, exactly as a visitor.
# curl options:
#   --fail                         : HTTP status >= 400 => curl exits non-zero
#   --retry 5 --retry-connrefused  : tolerate a container that is still binding
#   --max-time 5                   : never hang a deploy on a stuck connection

# Print at most the first 100 characters of a response, on one line.
short() { local s="${1//$'\n'/ }"; printf '%s' "${s:0:100}"; }

# smoke_exec <label> <service> <url>: HTTP GET from inside a container
# (busybox wget ships with every Alpine-based image in this stack).
smoke_exec() {
  local label=$1 service=$2 url=$3 body
  if body="$(compose exec -T "$service" wget -q -O - "$url" 2>&1)"; then
    ok "${label}: ${service} ${url} -> $(short "$body")"
  else
    compose ps -a >&2 || true
    die "Smoke test failed: ${label} (${service} ${url}): $(short "$body")"
  fi
}

# smoke_curl <label> <curl arguments...>: HTTP request from the host.
smoke_curl() {
  local label=$1 body
  shift
  if body="$(curl --fail --silent --show-error --max-time 5 \
    --retry 5 --retry-delay 2 --retry-connrefused "$@" 2>&1)"; then
    ok "${label} -> $(short "$body")"
  else
    compose ps -a >&2 || true
    die "Smoke test failed: ${label}: $(short "$body")"
  fi
}

# a) Inside the containers.
smoke_exec "backend  health " backend  "http://127.0.0.1:3000/api/health"
smoke_exec "frontend health " frontend "http://127.0.0.1:8080/healthz"
# frontend -> backend over the "edge" network (the frontend nginx's own /api/
# proxy, via Docker DNS "backend:3000"): the container-to-container path works.
smoke_exec "frontend -> api " frontend "http://127.0.0.1:8080/api/health"

# b) Through the proxy. Its own liveness endpoint first (port 80, both modes).
smoke_curl "proxy health    " "http://127.0.0.1/healthz"

if [[ "$proxy_mode" == "https" ]]; then
  # Port 80 must redirect to https://DOMAIN (the Host header selects the site).
  redirect="$(curl --silent --max-time 5 --output /dev/null --write-out '%{http_code} %{redirect_url}' \
    -H "Host: ${DOMAIN}" "http://127.0.0.1/" || true)"
  [[ "$redirect" == "301 https://${DOMAIN}/" ]] \
    || die "Smoke test failed: http://${DOMAIN}/ should answer '301 https://${DOMAIN}/', got '${redirect}'."
  ok "http -> https   -> ${redirect}"

  # --resolve DOMAIN:443:127.0.0.1 = "connect to 127.0.0.1, but send SNI and
  # Host for DOMAIN and check the certificate against DOMAIN": a real HTTPS
  # request to the real name, without depending on public DNS. curl verifies
  # the chain against the system's CA store - an expired or wrong certificate
  # fails right here.
  tls_args=(--resolve "${DOMAIN}:443:127.0.0.1")
  tls_rc=0
  curl --silent --output /dev/null --max-time 5 --retry 3 --retry-connrefused \
    "${tls_args[@]}" "https://${DOMAIN}/" 2>/dev/null || tls_rc=$?
  if [[ "$tls_rc" == "60" ]]; then
    # Exit 60 = certificate not trusted. Expected with `tls.sh issue --staging`
    # (Let's Encrypt's staging CA is not in any trust store) or a self-signed
    # rehearsal certificate: still test the app path, but say so loudly.
    warn "The certificate for ${DOMAIN} is NOT trusted (staging/self-signed?). Testing with --insecure; get a real one with: ./deploy/tls.sh issue"
    tls_args+=(--insecure)
  fi
  smoke_curl "https api       " "${tls_args[@]}" "https://${DOMAIN}/api/health"
  smoke_curl "https page      " "${tls_args[@]}" --output /dev/null --write-out 'HTTP %{http_code}, HTTP/%{http_version}' "https://${DOMAIN}/"
  site_url="https://${DOMAIN}"
else
  # HTTP-only mode: the app is served on port 80 for ANY Host header. Send the
  # real name when there is one (stage 2); in stage 1 curl sends
  # "Host: 127.0.0.1", just like a browser typing the IP sends the IP.
  host_args=()
  [[ -z "$DOMAIN" ]] || host_args=(-H "Host: ${DOMAIN}")
  smoke_curl "http api        " ${host_args[@]+"${host_args[@]}"} "http://127.0.0.1/api/health"
  smoke_curl "http page       " ${host_args[@]+"${host_args[@]}"} --output /dev/null --write-out 'HTTP %{http_code}' "http://127.0.0.1/"
  if [[ -n "$DOMAIN" ]]; then
    site_url="http://${DOMAIN}"
  else
    # On Google Cloud the metadata server knows the VM's EXTERNAL IP (the VM's
    # own network interface only has the internal 10.x one). 2 s max, and
    # off Google Cloud we just print a placeholder.
    external_ip="$(curl -fsS --max-time 2 -H 'Metadata-Flavor: Google' \
      'http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip' 2>/dev/null || true)"
    [[ "$external_ip" =~ ^[0-9]+(\.[0-9]+){3}$ ]] || external_ip="<this server's external IP>"
    site_url="http://${external_ip}"
  fi
fi

# =============================================================================
step 7 "Cleaning up dangling images"
# =============================================================================
# After a pull, the image that USED to be tagged ":latest" loses its tag and
# becomes "dangling" (<none>:<none>). `image prune -f` deletes exactly those.
# Images that still carry a tag (older sha-* builds) are kept on purpose: they
# make a rollback instant. To reclaim more space by hand:
#   docker image prune -a --filter "until=168h"   # unused images older than 7 days
#
# Note: prune is machine-wide - it deletes EVERY dangling image on this Docker
# host, not only ours. Fine on a dedicated server; on your laptop it would also
# clean up other projects' leftovers. That is one more reason SKIP_PULL=1 skips
# it: without a pull, this deploy created no dangling images to clean up.
if [[ "$SKIP_PULL" == "1" ]]; then
  info "Skipped (SKIP_PULL=1): nothing was pulled, so this deploy left no dangling images."
else
  docker image prune -f
  ok "Dangling images removed"
fi

# =============================================================================
step 8 "Status"
# =============================================================================
compose ps --format 'table {{.Service}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'

printf '\n%s%sDeploy finished in %ss.%s Live at %s (proxy mode: %s)\n' \
  "$C_BOLD" "$C_GREEN" "$SECONDS" "$C_RESET" "$site_url" "$proxy_mode"
printf '%sLogs: docker compose -f %s --env-file %s logs -f --tail=100%s\n' \
  "$C_DIM" "$COMPOSE_FILE_PATH" "$ENV_FILE_PATH" "$C_RESET"
