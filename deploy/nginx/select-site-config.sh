#!/bin/sh
# shellcheck shell=sh
# =============================================================================
# select-site-config.sh - choose the HTTP-only or the HTTPS site config
# -----------------------------------------------------------------------------
# Runs inside the "proxy" container (official nginx image) every time it
# STARTS. docker-compose.prod.yml mounts this whole folder (deploy/nginx/) at
# /etc/nginx/bugsquash/ and starts the container with a two-step entrypoint:
#
#   1. . /etc/nginx/bugsquash/select-site-config.sh    <- this file
#   2. exec /docker-entrypoint.sh nginx -g 'daemon off;'  <- the image's own start-up
#
# The image's entrypoint (step 2) renders every *.template file found in
# $NGINX_ENVSUBST_TEMPLATE_DIR into /etc/nginx/conf.d/ (a tmpfs in our stack),
# replacing ${DOMAIN}, and then starts nginx. All THIS file does is point that
# variable at one of two template folders:
#
#   DOMAIN empty (stage 1)          ->  templates/http-only  (http://<VM IP>)
#   no certificate for $DOMAIN yet  ->  templates/http-only  (stage 2, http://<DOMAIN>)
#   certificate for $DOMAIN exists  ->  templates/https      (stage 3+)
#
# Both folders contain a "site.conf.template", so the result is always the same
# file, /etc/nginx/conf.d/site.conf - only its content differs. Switching to
# HTTPS is therefore just "restart the proxy" once certbot got the certificate:
#     docker compose -f docker-compose.prod.yml --env-file .env.prod restart proxy
# (deploy/tls.sh does the same; deploy/deploy.sh re-runs this file + the
# rendering inside the running proxy and reloads nginx on every deploy).
#
# Why SOURCED (". file") instead of executed? A sourced file runs inside the
# calling shell, so the variable it exports is still there for step 2. It also
# means the file does not need the executable bit, which is easily lost when
# the bundle is copied from Windows - nothing here depends on chmod +x.
#
# Rules for a sourced file: never `exit` (that would end the container's
# start-up), and prefix helper variables (they live in the caller's shell).
# =============================================================================

bugsquash_templates=/etc/nginx/bugsquash/templates
bugsquash_cert_dir="/etc/letsencrypt/live/${DOMAIN:-}"

if [ -z "${DOMAIN:-}" ]; then
    # Stage 1: no domain yet - the HTTP-only site answers on the bare IP.
    echo "select-site-config: DOMAIN is empty - using the HTTP-only site config (any host name, e.g. http://<server IP>/)"
    NGINX_ENVSUBST_TEMPLATE_DIR="$bugsquash_templates/http-only"
# -s = exists and is not empty. It follows symlinks, so it checks the real
# file in archive/ that live/ points to (a dangling link counts as missing).
# The proxy can read these root-only (0600) files because this start-up runs
# as root - see the proxy service in docker-compose.prod.yml.
elif [ -s "$bugsquash_cert_dir/fullchain.pem" ] && [ -s "$bugsquash_cert_dir/privkey.pem" ]; then
    echo "select-site-config: certificate found for ${DOMAIN} - using the HTTPS site config"
    NGINX_ENVSUBST_TEMPLATE_DIR="$bugsquash_templates/https"
else
    echo "select-site-config: no certificate for ${DOMAIN} yet - using the HTTP-only site config (app + ACME challenges on port 80)"
    NGINX_ENVSUBST_TEMPLATE_DIR="$bugsquash_templates/http-only"
fi

export NGINX_ENVSUBST_TEMPLATE_DIR
unset bugsquash_templates bugsquash_cert_dir
# The last command decides this file's exit status, and the entrypoint only
# continues ("&&") on success: `unset` always succeeds.
