#!/usr/bin/env bash
# =============================================================================
# deploy/deploy.sh - pull and (re)start Bug Squash Arena on the production server
# -----------------------------------------------------------------------------
# Usage (on the Google Cloud VM, as the non-root "deploy" user):
#
#   ./deploy/deploy.sh                 # deploy IMAGE_TAG from .env.prod ("latest")
#   ./deploy/deploy.sh sha-1a2b3c4     # deploy - or ROLL BACK to - an exact build
#   ./deploy/deploy.sh --help
#
# The optional deploy job in .github/workflows/ci-main.yml runs, over SSH:
#
#   cd /opt/devops-workshop && git pull --ff-only && ./deploy/deploy.sh sha-<short>
#
# What happens, step by step (every step is idempotent: re-running is safe):
#
#   1. Pre-flight  : docker + compose plugin present, daemon reachable, .env.prod
#                    present, nobody else deploying at the same moment.
#   2. Validate    : render docker-compose.prod.yml with .env.prod. Missing
#                    secrets (${VAR:?...}) abort HERE, before anything changes.
#   3. Pull        : download the new images. Only layers that changed are
#                    transferred - image LAYERS are content-addressed, so the
#                    node:24-alpine base layers are already on disk.
#   4. Up          : recreate only the containers whose image or config
#                    changed, then WAIT until their healthchecks pass.
#   5. Smoke test  : curl the same loopback ports the host nginx proxies to.
#   6. Clean up    : delete dangling images so the disk does not fill up.
#   7. Status      : print what is running now.
#
# Why a script and not just two commands? Because a deploy is a procedure, and
# procedures that live in someone's head are executed differently every time.
# A script is the same on every run, for humans and for CI.
#
# Optional environment variables:
#   WAIT_TIMEOUT   seconds to wait for healthy containers (default: 180)
#   NO_COLOR       set to anything to disable colored output (https://no-color.org)
#   SKIP_PULL=1    rehearsal mode: do NOT pull from Docker Hub, run the images
#                  already on this machine (e.g. built locally as
#                  local/bugsquash-*:ci, like the ci-test workflow does), and
#                  skip the image prune. Never needed on the real server.
#                  Example, on your laptop:
#                    docker build --target production -t local/bugsquash-backend:ci app/backend
#                    docker build --target production -t local/bugsquash-frontend:ci app/frontend
#                    # .env.prod with DOCKER_HUB_USERNAME=local and COOKIE_SECURE=false
#                    SKIP_PULL=1 ./deploy/deploy.sh ci
# =============================================================================

# -E : ERR trap is inherited by functions (so on_error below fires everywhere)
# -e : exit on the first failing command      -u : unset variable = error
# -o pipefail : a pipeline fails if ANY command in it fails, not just the last
set -Eeuo pipefail

# ---- Pretty output ----------------------------------------------------------
# Colors only when stdout is a terminal. When CI captures the output over SSH,
# raw escape codes would just make the log unreadable.
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_RESET=$'\033[0m'  C_BOLD=$'\033[1m'   C_DIM=$'\033[2m'
  C_RED=$'\033[31m'   C_GREEN=$'\033[32m' C_YELLOW=$'\033[33m' C_BLUE=$'\033[34m'
else
  C_RESET='' C_BOLD='' C_DIM='' C_RED='' C_GREEN='' C_YELLOW='' C_BLUE=''
fi

readonly TOTAL_STEPS=7
step() { printf '\n%s==> [%s/%s] %s%s\n' "${C_BOLD}${C_BLUE}" "$1" "$TOTAL_STEPS" "$2" "$C_RESET"; }
info() { printf '  %s->%s %s\n' "$C_DIM" "$C_RESET" "$*"; }
ok()   { printf '  %s[ok]%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '  %s[warn] %s%s\n' "$C_YELLOW" "$*" "$C_RESET" >&2; }
die()  { printf '\n  %s[fail] %s%s\n' "${C_BOLD}${C_RED}" "$*" "$C_RESET" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: ./deploy/deploy.sh [IMAGE_TAG]

Pulls the Bug Squash Arena images from Docker Hub and (re)starts the production
stack defined in docker-compose.prod.yml, using secrets from .env.prod.

  IMAGE_TAG   optional, e.g. "latest" or "sha-1a2b3c4". Overrides IMAGE_TAG
              from .env.prod for this deploy only. Use an older sha-* tag to
              roll back.

Environment: WAIT_TIMEOUT (default 180 seconds), NO_COLOR,
             SKIP_PULL=1 (use local images, no pull/prune - for rehearsals).
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

# The two files every production compose command needs (relative to the repo root).
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
    die "Invalid image tag '$1' (allowed: letters, digits, '_', '.', '-'; max 128 chars)."
  fi
  # Compose's interpolation precedence: variables from the SHELL ENVIRONMENT
  # beat values from --env-file. Exporting IMAGE_TAG therefore overrides the
  # IMAGE_TAG line in .env.prod for this run only - .env.prod stays untouched.
  export IMAGE_TAG="$1"
  tag_source="the command line (overrides $ENV_FILE_PATH)"
fi

readonly WAIT_TIMEOUT="${WAIT_TIMEOUT:-180}"
[[ "$WAIT_TIMEOUT" =~ ^[0-9]+$ ]] || die "WAIT_TIMEOUT must be a whole number of seconds (got '$WAIT_TIMEOUT')."

readonly SKIP_PULL="${SKIP_PULL:-0}"
[[ "$SKIP_PULL" =~ ^[01]$ ]] || die "SKIP_PULL must be 0 or 1 (got '$SKIP_PULL')."

# ---- Locate the repository ------------------------------------------------------
# Resolve paths from the script's OWN location, not from the caller's current
# directory, so "./deploy/deploy.sh", "deploy.sh" (from inside deploy/) and an
# absolute path from cron or CI all behave the same.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
readonly SCRIPT_DIR REPO_ROOT
cd -- "$REPO_ROOT"

# Every compose call goes through this wrapper, so the file, the env file and
# the project directory can never accidentally differ between steps. The
# project NAME ("bugsquash") comes from the `name:` key inside the file.
compose() {
  docker compose \
    --project-directory "$REPO_ROOT" \
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

printf '%sBug Squash Arena - production deploy%s  %s(repo: %s)%s\n' \
  "$C_BOLD" "$C_RESET" "$C_DIM" "$REPO_ROOT" "$C_RESET"

# =============================================================================
step 1 "Pre-flight checks"
# =============================================================================
command -v docker >/dev/null 2>&1 \
  || die "docker not found. Install Docker Engine first (deploy/gcp-vm-setup.md, step 8)."

docker compose version >/dev/null 2>&1 \
  || die "The Docker Compose v2 plugin is missing ('docker compose'). Install the docker-compose-plugin package."

# `docker info` talks to the daemon over /var/run/docker.sock. It fails if the
# daemon is down OR if this user may not open the socket (not in the docker group).
docker info >/dev/null 2>&1 \
  || die "Cannot reach the Docker daemon. Is it running (systemctl status docker)? Is '$(id -un)' in the 'docker' group (sudo usermod -aG docker $(id -un), then log out and back in)?"

command -v curl >/dev/null 2>&1 || die "curl not found (sudo apt install curl)."

[[ -f "$COMPOSE_FILE_PATH" ]] || die "$COMPOSE_FILE_PATH not found in $REPO_ROOT."
[[ -f "$ENV_FILE_PATH" ]] \
  || die "$ENV_FILE_PATH not found. Create it: cp .env.prod.example .env.prod && chmod 600 .env.prod - then fill in the secrets."

# .env.prod holds the database password and the JWT signing secret. The last
# digit of the octal mode is "others": anything but 0 means every account on
# this server can read our secrets. (GNU stat syntax - this runs on Debian.)
env_mode="$(stat -c '%a' "$ENV_FILE_PATH" 2>/dev/null || true)"
if [[ -n "$env_mode" && "${env_mode: -1}" != "0" ]]; then
  warn "$ENV_FILE_PATH is readable by other users (mode $env_mode). Fix: chmod 600 $ENV_FILE_PATH"
fi

# One deploy at a time. A human deploying by hand while CI deploys the next
# commit would race. flock(1) takes an exclusive lock on the repo directory
# (file descriptor 9 stays open until the script exits, and so does the lock;
# the kernel releases it automatically even if we crash).
if command -v flock >/dev/null 2>&1; then
  exec 9<"$REPO_ROOT"
  flock -n 9 || die "Another deploy is already running in $REPO_ROOT. Wait for it to finish."
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
compose config -q || die "Compose configuration is invalid - see the message above (missing secret in $ENV_FILE_PATH?)."

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
# in the output - that is layer caching at work.
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
# one from the new image. The named volume pgdata is NOT touched.
#
# Expect a few seconds of downtime per recreated container. Zero-downtime
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
step 5 "Smoke tests (the same loopback ports the host nginx uses)"
# =============================================================================
# The containers being "healthy" is what Docker thinks. A smoke test checks it
# from the OUTSIDE - through Docker's port publishing, exactly the way the host
# nginx will reach the containers.
#   --fail                         : HTTP status >= 400 => curl exits non-zero
#   --retry 5 --retry-connrefused  : tolerate a container that is still binding
#   --max-time 5                   : never hang a deploy on a stuck connection
smoke_test() {
  local name=$1 url=$2 body
  if body="$(curl --fail --silent --show-error --max-time 5 \
    --retry 5 --retry-delay 2 --retry-connrefused "$url")"; then
    ok "${name}: ${url} -> ${body}"
  else
    compose ps -a >&2 || true
    die "Smoke test failed: ${name} (${url})."
  fi
}

# 1) backend directly          (host nginx: location /api/ -> 127.0.0.1:3000)
smoke_test "backend health " "http://127.0.0.1:3000/api/health"
# 2) frontend nginx itself     (host nginx: location /     -> 127.0.0.1:8080)
smoke_test "frontend health" "http://127.0.0.1:8080/healthz"
# 3) frontend -> backend over the "edge" Docker network (Docker DNS: backend:3000).
#    Proves the container-to-container path works, not just each container alone.
smoke_test "frontend -> api" "http://127.0.0.1:8080/api/health"

# =============================================================================
step 6 "Cleaning up dangling images"
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
step 7 "Status"
# =============================================================================
compose ps --format 'table {{.Service}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'

printf '\n%s%sDeploy finished in %ss.%s Live at https://devops.gulfheight.com\n' \
  "$C_BOLD" "$C_GREEN" "$SECONDS" "$C_RESET"
printf '%sLogs: docker compose -f %s --env-file %s logs -f --tail=100%s\n' \
  "$C_DIM" "$COMPOSE_FILE_PATH" "$ENV_FILE_PATH" "$C_RESET"
