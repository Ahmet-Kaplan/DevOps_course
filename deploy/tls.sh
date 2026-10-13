#!/usr/bin/env bash
# =============================================================================
# deploy/tls.sh - Let's Encrypt certificates for the containerized edge proxy
# -----------------------------------------------------------------------------
# Usage (on the server, as the user that owns /opt/devops-workshop, from anywhere):
#
#   ./deploy/tls.sh issue [--staging]   get a certificate for $DOMAIN, switch the proxy to HTTPS
#   ./deploy/tls.sh renew               renew if due, reload the proxy (systemd timer, 2x a day)
#   ./deploy/tls.sh status              list the certificates in the letsencrypt volume
#   ./deploy/tls.sh has-cert            exit 0 if a certificate for $DOMAIN exists, 1 if not
#   ./deploy/tls.sh --help
#
# This script is the SHORTCUT for the stage-3 commands you can also type by
# hand (they are exactly what it runs, plus safety checks):
#
#   C="docker compose -f docker-compose.prod.yml --env-file .env.prod"
#   $C run --rm certbot certonly --webroot -w /var/www/certbot -d <DOMAIN> \
#        --email <you@example.com> --agree-tos --no-eff-email [--staging]
#   $C restart proxy                                  # switch to the HTTPS config
#   $C run --rm certbot renew                         # renewal (only when due)
#   $C exec proxy nginx -s reload                     # load the renewed certificate
#
# Nothing is installed on the host: certbot runs as a ONE-OFF container
# (service "certbot", profile "tools" in docker-compose.prod.yml).
#
# How a certificate is obtained (ACME "HTTP-01" challenge, webroot method):
#
#   1. certbot asks Let's Encrypt for a certificate for $DOMAIN and gets a
#      random token back;
#   2. certbot writes the token as a file into the "certbot-webroot" volume;
#   3. Let's Encrypt fetches http://$DOMAIN/.well-known/acme-challenge/<token>
#      - the PROXY container serves that volume read-only on port 80;
#   4. token matches => you control the server the domain points at =>
#      Let's Encrypt signs; certbot stores key + certificate in the
#      "letsencrypt" volume under live/$DOMAIN/;
#   5. this script restarts the proxy: at start it sees the certificate and
#      renders the HTTPS config (deploy/nginx/select-site-config.sh).
#
# Who calls it:
#   * you, by hand (stage 3: issue --staging, then issue; status any time);
#   * the systemd timer deploy/systemd/bugsquash-tls-renew.timer (renew, 2x a day);
#   * Ansible (stage 5) right after the first deploy - so a rebuilt server
#     gets HTTPS with no manual step.
#
# `renew` is also the safety net for a server provisioned before DNS was
# right: if there is no certificate yet and DNS now points here, it obtains
# one. Fix the DNS record and the timer finishes the job within 12 hours.
#
# Settings come from .env.prod (or your shell, which wins - same rule as Compose):
#   DOMAIN              required for issue, e.g. devops.gulfheight.com (while it
#                       is empty - stage 1 - renew/status just say so and exit 0)
#   LETSENCRYPT_EMAIL   optional; empty => --register-unsafely-without-email
#                       (fine: Let's Encrypt stopped sending expiry emails in 2025)
# Environment variables:
#   FORCE=1        issue/renew: skip the DNS check (e.g. the record is proxied by
#                  Cloudflare on purpose, so it resolves to Cloudflare's IPs)
#   LOCK_TIMEOUT   seconds to wait for a running deploy.sh/tls.sh (default 600)
#   NO_COLOR       disable colored output
#
# Exit codes:
#   0  success (has-cert: a certificate exists)
#   1  error (has-cert: no certificate, or DOMAIN empty)
#   2  wrong usage
#   3  issue only: DNS for $DOMAIN does not point at this server - nothing was
#      requested from Let's Encrypt. Ansible treats this as a WARNING: the site
#      keeps running over plain HTTP until DNS is fixed.
#
# Let's Encrypt rate limits are real (e.g. 5 failed validations per hostname
# per hour, 5 identical certificates per week). That is why this script checks
# DNS and the local challenge path BEFORE asking, and why --staging exists:
# the staging CA has generous limits but issues certificates browsers do not trust.
# =============================================================================

# SC2016 = "expressions don't expand in single quotes". Intended here: the
# small scripts passed to in_volumes() are single-quoted ON PURPOSE so that
# their $1, $2 expand INSIDE the container, from the arguments we pass.
# shellcheck disable=SC2016

set -Eeuo pipefail

# ---- Pretty output (same helpers as deploy.sh) ---------------------------------
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_RESET=$'\033[0m'  C_BOLD=$'\033[1m'   C_DIM=$'\033[2m'
  C_RED=$'\033[31m'   C_GREEN=$'\033[32m' C_YELLOW=$'\033[33m' C_BLUE=$'\033[34m'
else
  C_RESET='' C_BOLD='' C_DIM='' C_RED='' C_GREEN='' C_YELLOW='' C_BLUE=''
fi

title() { printf '\n%s==> %s%s\n' "${C_BOLD}${C_BLUE}" "$*" "$C_RESET"; }
info()  { printf '  %s->%s %s\n' "$C_DIM" "$C_RESET" "$*"; }
ok()    { printf '  %s[ok]%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn()  { printf '  %s[warn] %s%s\n' "$C_YELLOW" "$*" "$C_RESET" >&2; }
die()   { printf '\n  %s[fail] %s%s\n' "${C_BOLD}${C_RED}" "$*" "$C_RESET" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: ./deploy/tls.sh <command>

  issue [--staging]  Obtain a Let's Encrypt certificate for $DOMAIN (HTTP-01,
                     webroot) and switch the proxy to HTTPS. Does nothing if a
                     certificate already exists. --staging = Let's Encrypt's
                     test CA (not trusted by browsers, generous rate limits).
  renew              Renew certificates that are due, then reload the proxy.
                     No certificate yet? Obtain one if DNS points here now.
  status             List the certificates in the letsencrypt volume.
  has-cert           Exit 0 if a certificate for $DOMAIN exists, else 1.

Settings: DOMAIN and LETSENCRYPT_EMAIL from .env.prod (shell variables win).
Environment: FORCE=1 (skip the DNS check), LOCK_TIMEOUT (default 600 s), NO_COLOR.
Exit codes: 0 ok, 1 error / no certificate (has-cert), 2 wrong usage,
            3 DNS does not point at this server (issue).
EOF
}

on_error() {
  local exit_code=$? line=$1
  printf '\n  %s[fail] tls.sh aborted (exit %s) at line %s: %s%s\n' \
    "${C_BOLD}${C_RED}" "$exit_code" "$line" "$BASH_COMMAND" "$C_RESET" >&2
  exit "$exit_code"
}
trap 'on_error $LINENO' ERR

readonly COMPOSE_FILE_PATH="docker-compose.prod.yml"
readonly ENV_FILE_PATH=".env.prod"
readonly EXIT_DNS_NOT_HERE=3
# Paths INSIDE the containers (both are named volumes, see docker-compose.prod.yml).
readonly WEBROOT="/var/www/certbot"          # volume certbot-webroot
readonly LE_DIR="/etc/letsencrypt"           # volume letsencrypt

# ---- Arguments ----------------------------------------------------------------
command="${1:-}"
[[ $# -gt 0 ]] && shift
staging=0
case "$command" in
  issue)
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --staging) staging=1 ;;
        *) printf 'Unknown option for issue: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
      esac
      shift
    done
    ;;
  renew | status | has-cert)
    [[ $# -eq 0 ]] || { usage >&2; exit 2; }
    ;;
  -h | --help | help) usage; exit 0 ;;
  "") usage >&2; exit 2 ;;
  *) printf 'Unknown command: %s\n\n' "$command" >&2; usage >&2; exit 2 ;;
esac

readonly FORCE="${FORCE:-0}"
[[ "$FORCE" =~ ^[01]$ ]] || die "FORCE must be 0 or 1 (got '$FORCE')."
readonly LOCK_TIMEOUT="${LOCK_TIMEOUT:-600}"
[[ "$LOCK_TIMEOUT" =~ ^[0-9]+$ ]] || die "LOCK_TIMEOUT must be a whole number of seconds (got '$LOCK_TIMEOUT')."

# ---- Locate the bundle (same as deploy.sh) --------------------------------------
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
BUNDLE_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
readonly SCRIPT_DIR BUNDLE_ROOT
cd -- "$BUNDLE_ROOT"

compose() {
  docker compose \
    --project-directory "$BUNDLE_ROOT" \
    -f "$COMPOSE_FILE_PATH" \
    --env-file "$ENV_FILE_PATH" \
    "$@"
}

# certbot <args...> : run certbot in a throwaway container (the image's
# ENTRYPOINT is `certbot`). -T = no TTY (works from systemd and Ansible).
# --progress quiet hides Compose's own "Container ... Created" lines; certbot's
# output is still shown.
certbot() {
  compose --progress quiet run --rm -T --quiet-pull certbot "$@"
}

# in_volumes '<sh script>' [args...] : run a tiny shell script in the certbot
# image, which mounts BOTH volumes read-write. Used to look at the volumes
# without needing the proxy to be up. Values are passed as positional
# arguments ($1, $2...), never pasted into the script text.
in_volumes() {
  local script=$1
  shift
  compose --progress quiet run --rm -T --quiet-pull --entrypoint sh certbot -c "$script" sh "$@"
}

# ---- Pre-flight -------------------------------------------------------------------
command -v docker >/dev/null 2>&1 || die "docker not found."
docker info >/dev/null 2>&1 \
  || die "Cannot reach the Docker daemon (is '$(id -un)' in the docker group?)."
command -v curl >/dev/null 2>&1 || die "curl not found (sudo apt install curl)."
[[ -f "$COMPOSE_FILE_PATH" ]] || die "$COMPOSE_FILE_PATH not found in $BUNDLE_ROOT."
[[ -f "$ENV_FILE_PATH" ]] || die "$ENV_FILE_PATH not found in $BUNDLE_ROOT (copy it from your laptop - see .env.prod.example - or let Ansible render it)."

# Ask Compose itself for the values: `config --environment` prints the variables
# exactly as Compose interpolates them (.env.prod quoting rules, comments, and
# shell variables overriding the file). No hand-written .env parser to get wrong.
env_dump="$(compose config --environment 2>/dev/null)" \
  || die "Cannot read the Compose configuration - run 'docker compose -f $COMPOSE_FILE_PATH --env-file $ENV_FILE_PATH config -q' to see why (Docker Compose >= 2.24 needed)."
env_value() { sed -n "s/^$1=//p" <<<"$env_dump" | tail -n 1; }
DOMAIN="$(env_value DOMAIN)"
LETSENCRYPT_EMAIL="$(env_value LETSENCRYPT_EMAIL)"
unset env_dump   # it also contains the secrets - don't keep them around
readonly DOMAIN LETSENCRYPT_EMAIL

# No domain yet (stage 1: the site runs on the bare IP) - there is nothing to
# get a certificate for. Not an error for the renewal timer or `status`.
if [[ -z "$DOMAIN" ]]; then
  case "$command" in
    renew | status)
      info "DOMAIN is empty in $ENV_FILE_PATH (stage 1) - no certificate to manage. Nothing to do."
      exit 0
      ;;
    has-cert)
      echo "no certificate (DOMAIN is empty in $ENV_FILE_PATH)"
      exit 1
      ;;
    *) die "DOMAIN is empty in $ENV_FILE_PATH. Point a DNS A record at this server, set DOMAIN (stage 2), copy .env.prod again and run 'docker compose ... up -d' first." ;;
  esac
fi
# A host name: letters, digits, dots, dashes. Also keeps odd characters out of
# every path and command line below.
[[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] \
  || die "DOMAIN '${DOMAIN}' in $ENV_FILE_PATH is not a valid host name (no http://, no slash)."
if [[ -n "$LETSENCRYPT_EMAIL" && ! "$LETSENCRYPT_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
  die "LETSENCRYPT_EMAIL '${LETSENCRYPT_EMAIL}' does not look like an e-mail address (or leave it empty)."
fi

# =============================================================================
# Building blocks
# =============================================================================

# cert_state: what the letsencrypt volume holds for DOMAIN
#   none        no certificate
#   production  certificate managed by certbot (renewal config present)
#   staging     same, but from Let's Encrypt's STAGING CA (untrusted)
#   unmanaged   certificate files without certbot renewal config (copied by hand)
cert_state() {
  in_volumes '
    live="$2/live/$1"; conf="$2/renewal/$1.conf"
    if [ ! -s "$live/fullchain.pem" ] || [ ! -s "$live/privkey.pem" ]; then echo none
    elif [ ! -f "$conf" ]; then echo unmanaged
    elif grep -q "acme-staging" "$conf"; then echo staging
    else echo production
    fi' "$DOMAIN" "$LE_DIR"
}

# Which archive file live/DOMAIN/fullchain.pem points to (fullchain1.pem,
# fullchain2.pem, ...). certbot bumps the number on every renewal, so a
# different answer before/after `certbot renew` means "renewed".
cert_version() {
  in_volumes 'readlink "$2/live/$1/fullchain.pem" 2>/dev/null || true' "$DOMAIN" "$LE_DIR"
}

proxy_running() {
  [[ -n "$(compose ps --status running -q proxy 2>/dev/null)" ]]
}

# Is the proxy CURRENTLY serving the HTTPS config? (The mode is chosen when
# the container starts, so a certificate can exist while it still runs HTTP-only.)
proxy_serves_https() {
  # -E '^[[:space:]]*listen[[:space:]]+443' = a real directive, not a comment.
  compose exec -T proxy grep -Eq '^[[:space:]]*listen[[:space:]]+443' /etc/nginx/conf.d/site.conf 2>/dev/null
}

# The server's public IPv4 address. On Google Cloud the METADATA SERVER knows
# the external IP (the VM's own network interface only has the internal one -
# GCE does 1:1 NAT outside the VM). Elsewhere, ask a "what is my IP" service.
public_ip() {
  local ip=""
  ip="$(curl -fsS --max-time 2 -H 'Metadata-Flavor: Google' \
    'http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip' 2>/dev/null)" || ip=""
  if [[ ! "$ip" =~ ^[0-9]+(\.[0-9]+){3}$ ]]; then
    ip="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null)" || ip=""
  fi
  [[ "$ip" =~ ^[0-9]+(\.[0-9]+){3}$ ]] && printf '%s' "$ip"
  return 0
}

# DOMAIN's A records as the INTERNET sees them. dig asks a public resolver
# (Cloudflare's 1.1.1.1) directly, skipping /etc/hosts and local caches; that
# is the view Let's Encrypt gets. Without dig: the system resolver.
resolve_domain() {
  local out
  if command -v dig >/dev/null 2>&1 \
    && out="$(dig +short +time=3 +tries=2 A "$DOMAIN" @1.1.1.1 2>/dev/null)"; then
    # +short also prints CNAME targets - keep only IPv4 addresses.
    grep -E '^[0-9]+(\.[0-9]+){3}$' <<<"$out" || true
  else
    getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u || true
  fi
}

# dns_points_here: 0 = yes (or check skipped), 1 = no (details in DNS_REPORT).
DNS_REPORT=""
dns_points_here() {
  local ip resolved
  if [[ "$FORCE" == "1" ]]; then
    warn "FORCE=1: skipping the DNS check."
    return 0
  fi
  ip="$(public_ip)"
  resolved="$(resolve_domain)"
  info "DNS check: ${DOMAIN} -> $(tr '\n' ' ' <<<"${resolved:-<no A record>}")(public view, 1.1.1.1); this server: ${ip:-<unknown>}"
  if [[ -z "$ip" ]]; then
    warn "Could not determine this server's public IP - cannot verify DNS, trying anyway."
    return 0
  fi
  if grep -qxF "$ip" <<<"$resolved"; then
    ok "DNS for ${DOMAIN} points at this server (${ip})"
    return 0
  fi
  DNS_REPORT="DNS for ${DOMAIN} does not point at this server.
       ${DOMAIN} resolves to: ${resolved:-<nothing - no A record>}
       this server's public IP: ${ip}"
  # 10/8, 172.16/12, 192.168/16 can never be reached from the internet.
  if grep -qE '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' <<<"$resolved"; then
    DNS_REPORT+="
       That is a PRIVATE address (RFC 1918) - unreachable from the internet. Often the VM's
       INTERNAL IP was copied instead of its EXTERNAL one (gcloud compute instances list)."
  fi
  DNS_REPORT+="
     Fix: Cloudflare dashboard -> your zone -> DNS -> Records -> A record for ${DOMAIN}
          -> IPv4 address ${ip}, Proxy status \"DNS only\" (grey cloud). Then wait until
          'dig +short ${DOMAIN} @1.1.1.1' prints ${ip} and run ./deploy/tls.sh issue again
          (or just re-run Ansible; the renewal timer also retries twice a day).
     Proxied through Cloudflare (orange cloud) ON PURPOSE? Then the record shows
     Cloudflare's IPs - re-run with FORCE=1 to skip this check.
     Meanwhile the site keeps working over plain HTTP: http://${DOMAIN}"
  return 1
}

# Write a file into the webroot volume and fetch it through the proxy on port
# 80 - the same path Let's Encrypt will take, minus the internet. Catches a
# broken proxy config BEFORE we spend one of the CA's failed-validation slots.
webroot_selftest() {
  local probe got
  probe="bugsquash-selftest-${RANDOM}${RANDOM}"
  in_volumes 'mkdir -p "$1/.well-known/acme-challenge" && printf "%s" "$2" > "$1/.well-known/acme-challenge/$2"' \
    "$WEBROOT" "$probe" || die "Could not write to the certbot-webroot volume."
  got="$(curl -fsS --max-time 5 -H "Host: ${DOMAIN}" \
    "http://127.0.0.1/.well-known/acme-challenge/${probe}" 2>&1)" || got="<${got}>"
  in_volumes 'rm -f "$1/.well-known/acme-challenge/$2"' "$WEBROOT" "$probe"
  [[ "$got" == "$probe" ]] \
    || die "The proxy does not serve the ACME webroot (http://127.0.0.1/.well-known/acme-challenge/... answered: ${got}). Check: docker compose -f $COMPOSE_FILE_PATH --env-file $ENV_FILE_PATH logs proxy"
  ok "ACME challenge path works locally (webroot volume -> proxy -> port 80)"
}

# Restart the proxy so its entrypoint renders the HTTPS config, and wait until
# it is healthy again (`up --wait --no-deps` does not recreate anything here:
# the configuration did not change; it just waits for the healthcheck).
switch_proxy_to_https() {
  info "Restarting the proxy so it picks up the certificate (a ~1 s blip)..."
  compose --progress quiet restart proxy
  compose up -d --no-deps --wait --wait-timeout 60 proxy >/dev/null 2>&1 \
    || die "The proxy did not come back healthy after the restart. Logs: docker compose -f $COMPOSE_FILE_PATH --env-file $ENV_FILE_PATH logs proxy"
  proxy_serves_https || die "The proxy restarted but is not serving HTTPS - see its logs."
  ok "Proxy restarted in HTTPS mode"
}

# A real HTTPS request to the real name, connected to 127.0.0.1 (--resolve),
# so it does not depend on public DNS. curl checks the certificate chain
# against the system CA store, so this proves the certificate is TRUSTED -
# except for staging certificates, which are expected to fail that check.
verify_https() {
  local insecure=() out state rc=0
  state="$(cert_state)" || die "Could not inspect the letsencrypt volume."
  if [[ "$state" == "staging" ]]; then
    warn "Staging certificate: browsers will NOT trust it (verifying with --insecure)."
    insecure=(--insecure)
  fi
  out="$(curl -fsS --max-time 10 --retry 5 --retry-delay 2 --retry-connrefused ${insecure[@]+"${insecure[@]}"} \
    --resolve "${DOMAIN}:443:127.0.0.1" -o /dev/null -w 'HTTP %{http_code}, HTTP/%{http_version}' \
    "https://${DOMAIN}/healthz" 2>&1)" || rc=$?
  if [[ "$rc" == "60" && "$state" == "unmanaged" ]]; then
    # curl exit 60 = certificate not trusted. A hand-copied certificate (e.g.
    # a self-signed one for a rehearsal) is allowed to be untrusted - say so.
    warn "The certificate for ${DOMAIN} is NOT trusted by this server's CA store (self-signed / hand-copied?)."
    rc=0
    out="$(curl -fsS --max-time 10 --insecure --resolve "${DOMAIN}:443:127.0.0.1" -o /dev/null \
      -w 'HTTP %{http_code}, HTTP/%{http_version}' "https://${DOMAIN}/healthz" 2>&1)" || rc=$?
  fi
  if [[ "$rc" == "0" ]]; then
    ok "https://${DOMAIN}/healthz -> ${out}"
  else
    die "HTTPS check failed (curl exit ${rc}): ${out%%$'\n'*}"
  fi
}

# One deploy.sh / tls.sh at a time: deploy.sh may recreate the proxy while we
# restart or reload it. Same lock (the bundle directory) as deploy.sh, but we
# WAIT for it - a renewal can always run a few minutes later.
take_lock() {
  command -v flock >/dev/null 2>&1 || { warn "flock not found - skipping the lock."; return 0; }
  exec 9<"$BUNDLE_ROOT"
  if ! flock -n 9; then
    info "A deploy or another tls.sh is running - waiting up to ${LOCK_TIMEOUT}s..."
    flock -w "$LOCK_TIMEOUT" 9 || die "Still locked after ${LOCK_TIMEOUT}s. Try again later."
  fi
}

# DNS is not ready: explain, then stop. For `issue` that is exit code 3 (so
# Ansible can tell "fix your DNS" apart from a real failure); for `renew` -
# usually the systemd timer - it is simply "not yet", so exit 0.
stop_dns_not_ready() {
  printf '\n  %s[dns] %s%s\n' "${C_BOLD}${C_YELLOW}" "$DNS_REPORT" "$C_RESET" >&2
  if [[ "$command" == "renew" ]]; then
    info "No certificate until DNS points here; the renewal timer will try again."
    exit 0
  fi
  exit "$EXIT_DNS_NOT_HERE"
}

# The actual certificate request (shared by `issue` and `renew`).
# Arguments = extra certbot arguments, e.g. --force-renewal (optional).
obtain_certificate() {
  local args=(certonly
    --webroot -w "$WEBROOT"     # HTTP-01 via the shared webroot volume
    --cert-name "$DOMAIN"       # stable lineage name => files in live/$DOMAIN/
    -d "$DOMAIN"
    --agree-tos                 # Let's Encrypt Subscriber Agreement
    --no-eff-email              # don't share the address with the EFF newsletter
    --non-interactive)          # never wait for keyboard input (Ansible, systemd)
  if [[ -n "$LETSENCRYPT_EMAIL" ]]; then
    args+=(--email "$LETSENCRYPT_EMAIL")
  else
    args+=(--register-unsafely-without-email)
  fi
  [[ "$staging" == "1" ]] && args+=(--staging)
  [[ $# -gt 0 ]] && args+=("$@")

  dns_points_here || stop_dns_not_ready
  proxy_running || die "The proxy is not running - Let's Encrypt could not reach the challenge. Start the stack first: ./deploy/deploy.sh"
  webroot_selftest

  info "certbot ${args[*]}"
  certbot "${args[@]}" || die "certbot could not obtain the certificate (see its output above). Common causes: port 80 blocked by the VPC firewall (network tag http-server), DNS not propagated yet, rate limit reached (try --staging)."
  ok "Certificate for ${DOMAIN} stored in the letsencrypt volume"
  switch_proxy_to_https
  verify_https
}

# =============================================================================
# Commands
# =============================================================================
cmd_issue() {
  local state label=""
  [[ "$staging" == "1" ]] && label=" (STAGING)"
  title "Issue a certificate for ${DOMAIN}${label}"
  take_lock
  state="$(cert_state)" || die "Could not inspect the letsencrypt volume."
  case "$state" in
    none)
      obtain_certificate
      return 0
      ;;
    staging)
      if [[ "$staging" == "0" ]]; then
        info "Replacing the STAGING certificate with a trusted one."
        # Without --force-renewal certbot keeps a certificate that is not due yet.
        obtain_certificate --force-renewal
        return 0
      fi
      ok "A staging certificate for ${DOMAIN} already exists - nothing to request."
      ;;
    production)
      ok "A certificate for ${DOMAIN} already exists - nothing to request (renewal: ./deploy/tls.sh renew)."
      ;;
    unmanaged)
      ok "A certificate for ${DOMAIN} already exists - nothing to request."
      warn "It has no certbot renewal config (copied by hand?), so it will NOT be renewed automatically."
      ;;
    *) die "Unexpected certificate state '${state}'." ;;
  esac
  # A certificate is already there: make sure the proxy actually uses it.
  if proxy_running; then
    proxy_serves_https || switch_proxy_to_https
    verify_https
  else
    warn "The proxy is not running - start the stack with ./deploy/deploy.sh"
  fi
}

cmd_renew() {
  local state before after
  title "Renew the certificate for ${DOMAIN} (if due)"
  take_lock
  state="$(cert_state)" || die "Could not inspect the letsencrypt volume."
  if [[ "$state" == "none" ]]; then
    # Typical after provisioning a server before its DNS record was right.
    # From the timer, "DNS still wrong" ends with exit 0 (see stop_dns_not_ready).
    info "No certificate for ${DOMAIN} yet - trying to obtain one."
    obtain_certificate
    return 0
  fi

  before="$(cert_version)"
  # certbot only renews certificates close to expiry (or when Let's Encrypt's
  # ARI says so). --quiet: print nothing unless something goes wrong. The
  # webroot settings are also stored in renewal/$DOMAIN.conf; repeated here so
  # the command is self-explanatory.
  # --no-random-sleep-on-renew: without a terminal, certbot waits a RANDOM
  # 0-8 minutes before a due renewal (to spread the load on Let's Encrypt).
  # Our systemd timer already adds a random delay (RandomizedDelaySec), and
  # while we sleep we hold the deploy lock - a deploy.sh started meanwhile
  # would give up waiting. So: no second sleep here.
  certbot renew --webroot -w "$WEBROOT" --quiet --no-random-sleep-on-renew \
    || die "certbot renew failed (see above). The current certificate stays in place until it expires; check 'journalctl -u bugsquash-tls-renew'."
  after="$(cert_version)"
  if [[ "$before" != "$after" ]]; then
    ok "Certificate renewed (${before##*/} -> ${after##*/})"
  else
    ok "Certificate not due for renewal - nothing changed"
  fi

  if ! proxy_running; then
    warn "The proxy is not running - it will load the current certificate when it starts."
    return 0
  fi
  if ! proxy_serves_https; then
    # e.g. a certificate restored from backup while the proxy was running.
    switch_proxy_to_https
  else
    # Graceful reload: new workers with the (possibly new) certificate, old
    # workers finish their requests. Cheap - safe to do even when nothing changed.
    compose exec -T proxy nginx -s reload 2>/dev/null
    ok "Proxy reloaded"
  fi
  if [[ "$before" != "$after" ]]; then
    # `nginx -s reload` only SIGNALS the master and returns at once; give the
    # new workers a moment, then prove the renewed certificate is served fine.
    sleep 2
    verify_https
  fi
}

cmd_status() {
  local state mode="not running"
  title "Certificates (letsencrypt volume)"
  certbot certificates
  state="$(cert_state)" || die "Could not inspect the letsencrypt volume."
  if proxy_running; then
    if proxy_serves_https; then mode="HTTPS"; else mode="HTTP-only"; fi
  fi
  info "DOMAIN=${DOMAIN}  certificate: ${state}  proxy: ${mode}"
}

cmd_has_cert() {
  local state
  state="$(cert_state)" || die "Could not inspect the letsencrypt volume."
  if [[ "$state" == "none" ]]; then
    echo "no certificate for ${DOMAIN}"
    exit 1
  fi
  echo "certificate for ${DOMAIN}: ${state}"
}

# =============================================================================
case "$command" in
  issue)    cmd_issue ;;
  renew)    cmd_renew ;;
  status)   cmd_status ;;
  has-cert) cmd_has_cert ;;
esac
