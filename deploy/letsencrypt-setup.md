# HTTPS with Let's Encrypt + host nginx (Debian 13)

Goal: `https://devops.gulfheight.com` served by the host nginx with a free,
automatically renewed Let's Encrypt certificate, proxying to the containers
on `127.0.0.1:3000` (API) and `127.0.0.1:8080` (frontend).

Files used from this repository:

| File | Purpose |
|------|---------|
| `deploy/nginx/bootstrap/devops.gulfheight.com.http-only.conf` | Temporary HTTP-only config, used **before** the certificate exists |
| `deploy/nginx/conf.d/devops.gulfheight.com.conf` | The real production config (HTTPS, HSTS, proxying) |

Both are installed under **the same name**:
`/etc/nginx/conf.d/devops.gulfheight.com.conf`.

---

## 0. Prerequisites

* Server prepared with [`hetzner-server-setup.md`](hetzner-server-setup.md):
  nginx installed, ufw allows 80 and 443, app deployed with `./deploy/deploy.sh`.
* DNS set up with [`cloudflare-dns-guide.md`](cloudflare-dns-guide.md), record
  in **DNS only (gray cloud)** mode:

  ```bash
  laptop$ dig +short devops.gulfheight.com @1.1.1.1    # must print YOUR server's IP
  ```

## How HTTP-01 validation works

Let's Encrypt only issues a certificate to someone who **controls** the domain.
With the HTTP-01 challenge, proof of control looks like this:

```
certbot (on your server)                     Let's Encrypt (the CA)
  |-- "I want a cert for devops.gulfheight.com" -->|
  |<-- "Then serve token XYZ at                ----|
  |     http://devops.gulfheight.com/.well-known/acme-challenge/XYZ"
  | puts the token where nginx serves it
  |-- "ready" ----------------------------------->|
  |                    CA resolves DNS, connects to YOUR IP on PORT 80,
  |                    fetches the token from several network vantage points
  |<-- "valid - here is your certificate" --------|
```

Hence the hard requirements: **DNS points to this server** and **port 80 is
reachable from the internet**.

## 1. Why a bootstrap config? (the chicken-and-egg problem)

The production config contains

```nginx
ssl_certificate /etc/letsencrypt/live/devops.gulfheight.com/fullchain.pem;
```

On a fresh server that file does not exist, so `nginx -t` fails and nginx
refuses to load the config. But to *get* the file, we need a working nginx on
port 80. The bootstrap config breaks the cycle: it is plain HTTP only, serves
the ACME challenge directory and already proxies the app.

## 2. Install certbot

```bash
deploy@server$ sudo apt update
deploy@server$ sudo apt install -y certbot python3-certbot-nginx
deploy@server$ certbot --version
```

`python3-certbot-nginx` is the plugin that lets certbot read and edit nginx
configs. The Debian package also installs and enables the systemd timer
`certbot.timer` for automatic renewal (step 7).

## 3. Install the bootstrap config

```bash
deploy@server$ cd /opt/devops-workshop
deploy@server$ sudo mkdir -p /var/www/certbot           # ACME webroot used by our configs
deploy@server$ sudo cp deploy/nginx/bootstrap/devops.gulfheight.com.http-only.conf \
                       /etc/nginx/conf.d/devops.gulfheight.com.conf
deploy@server$ sudo nginx -t
deploy@server$ sudo systemctl reload nginx
```

* `nginx -t` parses **all** config files and checks referenced files exist,
  without touching the running server. Always run it before a reload.
* `reload` sends **SIGHUP** to the nginx master process: it re-reads the
  config, starts new worker processes, and lets the old workers finish their
  current requests before exiting. No dropped connections - unlike `restart`
  (stop + start). Same signal ideas as `docker stop` sending SIGTERM to a
  container's PID 1.

Test from your laptop:

```bash
laptop$ curl -I http://devops.gulfheight.com/                  # 200 from the frontend container
laptop$ curl http://devops.gulfheight.com/api/health; echo      # JSON from the backend

# The ACME path, end to end:
deploy@server$ sudo mkdir -p /var/www/certbot/.well-known/acme-challenge
deploy@server$ echo ok | sudo tee /var/www/certbot/.well-known/acme-challenge/ping
laptop$ curl http://devops.gulfheight.com/.well-known/acme-challenge/ping    # prints: ok
deploy@server$ sudo rm /var/www/certbot/.well-known/acme-challenge/ping
```

If any of this fails, fix it now (see [Troubleshooting](#8-troubleshooting)) -
certbot would fail for the same reason, and failed attempts count against
Let's Encrypt's rate limits.

## 4. Obtain the certificate with `certbot --nginx`

```bash
deploy@server$ sudo certbot --nginx -d devops.gulfheight.com
```

> First time, or still experimenting? Add `--staging` (alias `--test-cert`).
> Staging certificates are not trusted by browsers, but staging has much
> higher rate limits. When everything works, run the command again without
> `--staging` and choose to replace the certificate.

### The prompts

| Prompt | What to answer | Why |
|--------|----------------|-----|
| Email address | a real address you read | Account recovery and important notices. (Let's Encrypt no longer sends expiry reminder emails, so monitoring renewal is up to you - step 7.) |
| Terms of Service | `Y` | required |
| Share email with the EFF | your choice | newsletter only |
| Redirect HTTP to HTTPS? | redirect (if asked) | Newer certbot versions add the redirect without asking. We replace the config in step 5 anyway |

Non-interactive equivalent (handy for scripts):

```bash
sudo certbot --nginx -d devops.gulfheight.com \
     --agree-tos -m you@example.com --no-eff-email --redirect
```

### What certbot just did

1. Created an ACME **account** and key under `/etc/letsencrypt/accounts/`.
2. Found the `server` block with `server_name devops.gulfheight.com` in our
   bootstrap file, injected a temporary location for the challenge token,
   reloaded nginx, let the CA validate, then removed it again.
3. Saved the certificate:

   ```
   /etc/letsencrypt/
   |-- archive/devops.gulfheight.com/   fullchain1.pem, privkey1.pem, ... (real files, one set per renewal)
   |-- live/devops.gulfheight.com/      fullchain.pem -> ../../archive/.../fullchain1.pem (SYMLINKS to the newest)
   |-- renewal/devops.gulfheight.com.conf   how to renew (authenticator = nginx, installer = nginx)
   |-- options-ssl-nginx.conf           recommended TLS settings, maintained by certbot
   '-- ssl-dhparams.pem                 Diffie-Hellman parameters
   ```

4. **Edited** `/etc/nginx/conf.d/devops.gulfheight.com.conf`: added
   `listen 443 ssl`, the certificate lines and a redirect, each marked
   `# managed by Certbot`, and reloaded nginx.

Your site already works over HTTPS now - with certbot's generic additions.

## 5. Swap in the full production config

The repository's config adds HTTP/2, HSTS and security headers, keepalive
upstreams, timeouts, gzip and per-site logs. It references exactly the files
certbot just created.

```bash
deploy@server$ cd /opt/devops-workshop
deploy@server$ sudo cp /etc/nginx/conf.d/devops.gulfheight.com.conf ~/devops.gulfheight.com.conf.certbot   # backup (outside conf.d!)
deploy@server$ sudo cp deploy/nginx/conf.d/devops.gulfheight.com.conf /etc/nginx/conf.d/devops.gulfheight.com.conf
deploy@server$ sudo nginx -t && sudo systemctl reload nginx
```

The backup goes to your home directory on purpose: every file matching
`/etc/nginx/conf.d/*.conf` is loaded, and two files defining the same
upstreams would make `nginx -t` fail.

> **Debian 12 (nginx 1.22):** `nginx -t` reports `unknown directive "http2"`.
> Edit `/etc/nginx/conf.d/devops.gulfheight.com.conf`: delete the
> `http2 on;` line and change the two listen lines to
> `listen 443 ssl http2;` and `listen [::]:443 ssl http2;` (this alternative
> is written in a comment right there).

## 6. Verify

```bash
# HTTP -> HTTPS redirect
laptop$ curl -sI http://devops.gulfheight.com/ | head -n 3
HTTP/1.1 301 Moved Permanently
Location: https://devops.gulfheight.com/

# HTTPS, HTTP/2 and the security headers
laptop$ curl -sI https://devops.gulfheight.com/ | grep -iE '^(HTTP|strict-transport|x-frame|x-content)'
HTTP/2 200
strict-transport-security: max-age=31536000; includeSubDomains
...

# The API through the host nginx
laptop$ curl -s https://devops.gulfheight.com/api/health; echo

# The certificate itself: issuer, name, validity
laptop$ openssl s_client -connect devops.gulfheight.com:443 -servername devops.gulfheight.com </dev/null 2>/dev/null \
          | openssl x509 -noout -issuer -subject -dates

# certbot's view
deploy@server$ sudo certbot certificates
```

Then open <https://devops.gulfheight.com>, sign up and play a round - the
login cookie is `Secure`, so it only works over HTTPS. For an external
opinion, run the free test at <https://www.ssllabs.com/ssltest/>.

> **HSTS is sticky.** After a browser has seen the header it refuses plain
> HTTP for this host for a year. That is the point - but while experimenting
> you can lower `max-age` to `300` in the config.

## 7. Automatic renewal

Let's Encrypt certificates are short-lived on purpose (90 days, and the CA
has announced even shorter lifetimes): a leaked key is only useful for a
short time, and short lifetimes force automation. certbot renews a
certificate when it gets close to expiry (by default 30 days before).

```bash
deploy@server$ systemctl list-timers certbot.timer      # runs twice a day (with a random delay)
deploy@server$ systemctl status certbot.timer --no-pager
deploy@server$ sudo certbot renew --dry-run             # full renewal against STAGING, nothing is saved
deploy@server$ journalctl -u certbot.service --since -7d   # what the timer did
```

`--dry-run` is the most important command in this file: if it succeeds, the
real renewal will succeed too.

### Reload nginx after a renewal (deploy hook)

nginx reads certificates when it (re)loads its config - a renewed file on
disk alone changes nothing. With the `nginx` installer (our case) certbot
reloads nginx itself, but a **deploy hook** makes it explicit and also covers
the `--webroot` and DNS-01 methods below, which never touch nginx:

```bash
deploy@server$ sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh >/dev/null <<'EOF'
#!/bin/sh
# Runs after every SUCCESSFUL renewal (not on attempts that renewed nothing).
# Test the config first, so a broken file never takes the site down.
nginx -t -q && systemctl reload nginx
EOF
deploy@server$ sudo chmod 755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
```

To check that the running nginx serves the new certificate after a renewal,
compare the `-dates` from step 6 with `sudo certbot certificates`.

## 8. Troubleshooting

Logs first: `/var/log/letsencrypt/letsencrypt.log` and
`/var/log/nginx/devops.gulfheight.com.error.log`.

**Port 80 blocked** - certbot reports *"Timeout during connect (likely firewall problem)"*.

```bash
deploy@server$ sudo ufw status                          # 80/tcp must be ALLOW
deploy@server$ sudo ss -tlnp | grep -E ':80\b'          # nginx must listen on 0.0.0.0:80
laptop$ curl -I http://203.0.113.10/                    # from OUTSIDE the server
```

Also check the Hetzner Cloud Firewall (if you created one) - it filters
before ufw ever sees the packet.

**DNS not propagated / wrong** - *"DNS problem: NXDOMAIN looking up A for
devops.gulfheight.com"* or the CA connects to a wrong IP.

```bash
laptop$ dig +short devops.gulfheight.com A    @1.1.1.1
laptop$ dig +short devops.gulfheight.com AAAA @1.1.1.1   # an AAAA record is PREFERRED by Let's Encrypt
```

A stale or wrong **AAAA** record is a classic: IPv4 works in your browser,
but the CA validates over IPv6 and fails. Fix or delete the AAAA record.

**Cloudflare proxy interfering** - with the orange cloud the CA talks to
Cloudflare, not to you. Edge redirects ("Always Use HTTPS"), caching or the
WAF can break the challenge. Switch the record to **DNS only** while issuing,
or use DNS-01 (below), which does not involve HTTP at all.

**404 / "unauthorized" for the challenge** - the request reached *a* web
server, but not the right `server` block: check `server_name`, that the
bootstrap file really is in `/etc/nginx/conf.d/`, and that no other site
answers for the name: `sudo nginx -T | grep -n server_name`.

**`nginx -t`: cannot load certificate ... No such file** - the production
config was installed before a certificate existed. Go back to step 3.

**Rate limits** - for example 5 certificates per identical set of names per
week, and 5 failed validations per name per hour (details:
<https://letsencrypt.org/docs/rate-limits/>). Debug with `--staging`, and
use `certbot renew --dry-run` for renewals - neither counts against the
production limits.

## 9. Alternatives to `certbot --nginx`

### 9.1 `certonly --webroot` (certbot never edits nginx configs)

Our configs serve `/.well-known/acme-challenge/` from `/var/www/certbot`, so
certbot can simply drop the token file there while nginx keeps running:

```bash
deploy@server$ sudo certbot certonly --webroot -w /var/www/certbot -d devops.gulfheight.com
```

`certonly` only obtains the certificate - nginx is not modified, and the
deploy hook from step 7 reloads it after renewals. One catch: the nginx
plugin is what creates `options-ssl-nginx.conf` and `ssl-dhparams.pem`. If
you never ran `certbot --nginx`, create them before installing the
production config:

```bash
deploy@server$ sudo openssl dhparam -out /etc/letsencrypt/ssl-dhparams.pem 2048
deploy@server$ sudo tee /etc/letsencrypt/options-ssl-nginx.conf >/dev/null <<'EOF'
# Same settings certbot's nginx plugin installs.
ssl_session_cache shared:le_nginx_SSL:10m;
ssl_session_timeout 1440m;
ssl_session_tickets off;
ssl_protocols TLSv1.2 TLSv1.3;
ssl_prefer_server_ciphers off;
ssl_ciphers "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384";
EOF
```

### 9.2 DNS-01 with `certbot-dns-cloudflare`

Instead of serving a file over HTTP, certbot proves control by creating a TXT
record `_acme-challenge.devops.gulfheight.com` through Cloudflare's API.
Advantages: port 80 does not need to be reachable, it works with the orange
cloud, and it is the only way to get **wildcard** certificates
(`*.gulfheight.com`).

1. **Create a scoped API token** - never use the Global API Key, which can
   do *everything* in your Cloudflare account. Cloudflare dashboard ->
   **My Profile** -> **API Tokens** -> **Create Token** -> template
   **Edit zone DNS**:
   * Permissions: `Zone` - `DNS` - `Edit`
   * Zone Resources: `Include` - `Specific zone` - `gulfheight.com`
   * Optional: *Client IP Address Filtering* = your server's IP

   If the token leaks, the attacker can change DNS records of this one zone -
   and nothing else.

2. **Store it** readable by root only (certbot warns about looser permissions):

   ```bash
   deploy@server$ sudo apt install -y python3-certbot-dns-cloudflare
   deploy@server$ sudo install -d -m 700 /root/.secrets
   deploy@server$ sudo tee /root/.secrets/cloudflare.ini >/dev/null <<'EOF'
   dns_cloudflare_api_token = PASTE_THE_TOKEN_HERE
   EOF
   deploy@server$ sudo chmod 600 /root/.secrets/cloudflare.ini
   ```

3. **Request the certificate:**

   ```bash
   deploy@server$ sudo certbot certonly \
       --dns-cloudflare \
       --dns-cloudflare-credentials /root/.secrets/cloudflare.ini \
       --dns-cloudflare-propagation-seconds 30 \
       -d devops.gulfheight.com
   ```

The certificate lands in the same `/etc/letsencrypt/live/devops.gulfheight.com/`
path, so the production nginx config works unchanged (create
`options-ssl-nginx.conf` / `ssl-dhparams.pem` as in 9.1 if they do not exist).
Renewals reuse the stored settings; the deploy hook reloads nginx.
