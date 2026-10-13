# Cloudflare DNS: point `devops.gulfheight.com` at the Google Cloud VM

The root domain `gulfheight.com` is already managed by Cloudflare DNS (its
nameservers are `*.ns.cloudflare.com`). We add **one record** for the
sub-domain `devops` and decide whether Cloudflare should only *answer DNS
queries* for it (gray cloud) or also *proxy the traffic* (orange cloud).

Prerequisites: you have reserved the VM's **static external IP**
(`devops-workshop-ip`, see
[`gcp-vm-setup.md`, step 2](gcp-vm-setup.md#2-reserve-a-static-external-ip)).
The VM itself does not even have to exist yet: the address is reserved in
your project and stays the same across VM stops, starts and rebuilds. Print it
with:

```bash
laptop$ gcloud compute addresses describe devops-workshop-ip \
          --region=europe-west3 --format='get(address)'
```

or look it up in the Cloud Console under **VPC network** -> **IP addresses**.
Examples below use the documentation address `203.0.113.10`.

> **Use the static IP, never an ephemeral one.** A VM created without a
> reserved address gets an *ephemeral* external IP, which Google may hand to
> someone else when the VM stops. Your A record (and the `DEPLOY_HOST`
> secret) would then point at a stranger's machine.

> **Recommendation in one sentence:** use **DNS only (gray cloud)** while you
> obtain the Let's Encrypt certificate; afterwards you may switch to
> **Proxied (orange cloud)** with SSL/TLS mode **Full (strict)** - and
> **never "Flexible"**.

---

## 1. How DNS resolution works here (30-second version)

```
browser: "IP of devops.gulfheight.com?"
   |
   v
recursive resolver (ISP, 1.1.1.1, 8.8.8.8 ...)  -- answers from its CACHE if it can
   |  cache miss: ask the authority
   v
.com servers: "gulfheight.com is served by xxx.ns.cloudflare.com"
   |
   v
Cloudflare authoritative DNS: "devops.gulfheight.com  A  203.0.113.10  (TTL 300)"
```

The **TTL** (time to live) is how many seconds resolvers may cache the answer.
A short TTL means changes (e.g. a new server IP) are picked up quickly; a long
TTL means fewer queries. 300 s (5 minutes) is a good value for a service you
are still building.

## 2. Create the A record (IPv4)

1. Log in at <https://dash.cloudflare.com> and select the zone **gulfheight.com**.
2. **DNS** -> **Records** -> **Add record**.
3. Fill in:

   | Field | Value | Notes |
   |-------|-------|-------|
   | Type | `A` | A = IPv4 address |
   | Name | `devops` | Cloudflare appends the zone: `devops.gulfheight.com` |
   | IPv4 address | `203.0.113.10` | the VM's static external IP (`devops-workshop-ip`) |
   | Proxy status | **DNS only** (gray cloud) | switch the orange cloud OFF for now |
   | TTL | `Auto` (= 300 s for DNS-only records) or `5 min` | proxied records always use Auto |

4. **Save**.

## 3. No AAAA record (IPv6) for this setup

Do **not** create an AAAA record. Our VM lives in the project's `default`
VPC network, which is IPv4-only, so the VM has no public IPv6 address at all.
(Compute Engine supports external IPv6, but only on a *dual-stack* subnet of a
custom VPC network - more moving parts than this workshop needs.) Our nginx
config also listens on `[::]:80` and `[::]:443`; that is harmless and keeps it
ready for a dual-stack network later.

> **Gotcha:** Let's Encrypt **prefers IPv6** when an AAAA record exists. A
> wrong or unreachable AAAA record (for example, one left over from an older
> server) is a classic reason for certificate validation failures, even though
> everything works over IPv4. Delete any AAAA record for `devops`.

## 4. Verify the record

DNS changes in Cloudflare are live within seconds, but resolvers that already
cached an answer (including a "does not exist" answer, so-called *negative
caching*) keep it until it expires. Ask several resolvers directly:

```bash
laptop$ dig +short devops.gulfheight.com A                # your default resolver
laptop$ dig +short devops.gulfheight.com A @1.1.1.1       # Cloudflare's public resolver
laptop$ dig +short devops.gulfheight.com A @8.8.8.8       # Google's public resolver
laptop$ dig +short devops.gulfheight.com AAAA @1.1.1.1    # must print NOTHING (no IPv6 here)
laptop$ dig devops.gulfheight.com A @1.1.1.1 +noall +answer   # shows the remaining TTL too
laptop$ dig +short NS gulfheight.com                       # must list *.ns.cloudflare.com
```

Without `dig` (package `dnsutils` / `bind9-dnsutils` on Debian, `bind` on
macOS Homebrew):

```bash
laptop$ nslookup devops.gulfheight.com 1.1.1.1
PS> Resolve-DnsName devops.gulfheight.com -Server 1.1.1.1   # Windows PowerShell
```

**What you should see:**

* Gray cloud: exactly **the VM's static external IP** (`203.0.113.10`).
* Orange cloud: **Cloudflare's** anycast IPs (e.g. `104.21.x.x`, `172.67.x.x`)
  - your server's IP is hidden. This is the quickest way to tell which mode
  a record is in.

Then test the server end-to-end (once nginx runs on it):

```bash
laptop$ curl -I http://devops.gulfheight.com/
```

## 5. Orange cloud vs gray cloud

### The two request paths

**DNS only (gray cloud)** - Cloudflare just answers the DNS question; the
browser then talks *directly* to your server:

```
           (1) DNS: devops.gulfheight.com?  ->  203.0.113.10
 Browser  <------------------------------------------------>  Cloudflare DNS

           (2) HTTPS, certificate = Let's Encrypt (from YOUR nginx)
 Browser  ==================================================>  GCE VM 203.0.113.10
                                                               host nginx :443
                                                                 |-- /api/ -> 127.0.0.1:3000
                                                                 '-- /     -> 127.0.0.1:8080
```

**Proxied (orange cloud)** - DNS returns Cloudflare's IPs, so the browser
connects to a Cloudflare edge server, which opens a *second* connection to
your server:

```
           (1) DNS: devops.gulfheight.com?  ->  104.21.x.x  (Cloudflare edge)
 Browser  <------------------------------------------------>  Cloudflare DNS

           (2) HTTPS #1, certificate = Cloudflare edge certificate
 Browser  ==========================>  Cloudflare edge  (TLS terminated here: WAF,
                                        |               DDoS filter, cache, ...)
           (3) HTTPS #2, certificate = Let's Encrypt, VERIFIED in "Full (strict)"
                                        '=================>  GCE VM host nginx :443
                                                              (sees Cloudflare's IP as
                                                               the client address!)
```

Note that with the orange cloud Cloudflare **decrypts** the traffic at its
edge - that is what allows caching and a WAF, and it means Cloudflare can
read it. It is a reverse proxy, just like our host nginx, one hop earlier.

### Comparison

| | **DNS only (gray)** | **Proxied (orange)** |
|---|---|---|
| `dig` returns | your server's IP | Cloudflare anycast IPs |
| Who terminates the visitor's TLS | your nginx (Let's Encrypt cert) | Cloudflare edge (Cloudflare cert), then a 2nd TLS hop to your nginx |
| Server IP hidden | no | yes (as long as it is not leaked elsewhere) |
| DDoS protection, WAF, edge cache | no | yes (Free plan included) |
| Client IP seen by nginx / Express | the real visitor | a Cloudflare IP - needs `real_ip` + `CF-Connecting-IP` (section 7) |
| Non-HTTP traffic (e.g. SSH to the domain) | works | **does not work** - only HTTP(S) on specific ports is proxied |
| Let's Encrypt HTTP-01 | works directly | usually works, but edge redirects/caching can interfere; DNS-01 is safest |
| Limits | none added | e.g. ~100 s origin response timeout (error 524), 100 MB upload limit on Free |
| Debugging | one hop | two hops; errors may come from Cloudflare (52x) or from you |
| Good for | learning, cert issuance, direct debugging | public production sites |

### Recommendation

1. **Gray** while setting up and while issuing the first certificate: the
   fewest moving parts, and `curl`, `dig` and the nginx logs show the real picture.
2. Optionally **orange** afterwards, with:
   * SSL/TLS encryption mode **Full (strict)**,
   * the Cloudflare `real_ip` block enabled in the nginx config (section 7),
   * `DEPLOY_HOST` in GitHub Actions set to the VM's static external **IP**,
     never the domain - SSH does not pass through the orange cloud.

## 6. SSL/TLS encryption modes (only relevant for the orange cloud)

Cloudflare dashboard -> **SSL/TLS** -> **Overview**. The mode defines how
Cloudflare's edge connects to **your server** (hop 3 in the diagram):

| Mode | Edge -> origin | Verdict |
|------|----------------|---------|
| Off | HTTP only, visitors too | never |
| **Flexible** | **plain HTTP** to port 80 | **never** for this setup (see below) |
| Full | HTTPS, certificate **not** validated | encrypted, but an attacker on the path could present any certificate |
| **Full (strict)** | HTTPS, certificate validated (trusted CA + matching name + not expired) | **use this** - our Let's Encrypt cert passes |

If your zone shows **Automatic SSL/TLS**, choose **Custom SSL/TLS** and select
**Full (strict)** explicitly, so the mode cannot change behind your back.

### Why "Flexible" causes an infinite redirect loop

```
Browser --HTTPS--> Cloudflare --HTTP:80--> nginx: "port 80? -> 301 https://devops.gulfheight.com/"
Browser --HTTPS--> Cloudflare --HTTP:80--> nginx: "port 80? -> 301 https://devops.gulfheight.com/"
Browser --HTTPS--> Cloudflare --HTTP:80--> nginx: ...                 ERR_TOO_MANY_REDIRECTS
```

Our port-80 server redirects everything to HTTPS. In Flexible mode Cloudflare
*always* talks plain HTTP to the server, so every request is redirected again,
forever. And even without the loop, the second half of the journey would be
unencrypted while the browser shows a padlock - a false sense of security.

> Alternative to Let's Encrypt for orange-only setups: a **Cloudflare Origin
> CA certificate** (SSL/TLS -> Origin Server) is valid for up to 15 years but
> trusted **only** by Cloudflare's edge - switching back to gray would
> break HTTPS for visitors. With Let's Encrypt you can switch freely.

### Always Use HTTPS (SSL/TLS -> Edge Certificates)

With the orange cloud this makes Cloudflare's **edge** answer `http://`
requests with a redirect to `https://`, before they reach the server. Our
nginx does the same on port 80, so turning it on is harmless and saves a
round trip to the origin. Side effect: Let's Encrypt's HTTP-01 request for
`http://devops.gulfheight.com/.well-known/acme-challenge/...` is redirected
to HTTPS as well. That is why our nginx config serves the ACME directory on
**both** port 80 and 443 (so `certbot --webroot` renewals keep working).
With the gray cloud this setting has no effect - Cloudflare is not in the path.

HSTS is already sent by our nginx (`Strict-Transport-Security`); you do not
need to enable it again in Cloudflare.

## 7. Real client IPs behind the orange cloud

With the orange cloud every TCP connection to the server comes from a
Cloudflare IP. Consequences:

* the nginx access log shows Cloudflare IPs instead of visitors;
* Express computes `req.ip` from `X-Forwarded-For`, whose last entry is the
  Cloudflare edge - so the **per-IP login rate limit** (`AUTH_RATE_LIMIT_MAX`)
  lumps hundreds of visitors together, and one noisy user can lock out others.

Cloudflare sends the visitor's address in the `CF-Connecting-IP` header. The
nginx **realip** module can replace `$remote_addr` with it:

1. In `deploy/nginx/conf.d/devops.gulfheight.com.conf`, uncomment the block
   *"Real client IP behind Cloudflare"* (the `set_real_ip_from` lines and
   `real_ip_header CF-Connecting-IP;`).
2. Compare the ranges with the current list at <https://www.cloudflare.com/ips/>.
3. Install, test, reload:

   ```bash
   deploy@server$ sudo cp deploy/nginx/conf.d/devops.gulfheight.com.conf /etc/nginx/conf.d/
   deploy@server$ sudo nginx -t && sudo systemctl reload nginx
   ```

`set_real_ip_from` is the crucial part: nginx trusts the header **only** on
connections that really come from Cloudflare's networks. Without it, anybody
could connect to the server directly and claim any IP in a forged
`CF-Connecting-IP` header.

Optional hardening for an orange-only setup: restrict the GCP VPC firewall
rule `allow-http-https` to Cloudflare's IP ranges, so nobody can bypass
Cloudflare's WAF by connecting to the VM's IP directly:

```bash
laptop$ gcloud compute firewall-rules update allow-http-https \
          --source-ranges="$(curl -s https://www.cloudflare.com/ips-v4 | paste -sd, -)"
```

VPC firewall rules are additive: if any *other* rule still allows tcp:80/443
from `0.0.0.0/0` for the same network tags (for example `default-allow-http` /
`default-allow-https`, which the Cloud Console creates when you tick
*Allow HTTP/HTTPS traffic*), the restriction has no effect - check with
`gcloud compute firewall-rules list`. Do not do any of this while you still
need direct access, e.g. for HTTP-01 validation in gray mode; to undo it, set
`--source-ranges=0.0.0.0/0` again.

## 8. Troubleshooting

| Symptom | Likely cause | Check / fix |
|---------|--------------|-------------|
| `dig` returns nothing / NXDOMAIN | typo in the name, or negative caching | `dig @1.1.1.1 ...`; wait a few minutes |
| `dig` returns `104.x` / `172.67.x` | record is proxied (orange) | switch to DNS only if you need the real IP |
| `ERR_TOO_MANY_REDIRECTS` | orange + **Flexible** | set **Full (strict)** |
| Cloudflare error **526** | Full (strict) but origin cert invalid / expired | `sudo certbot certificates`; renew |
| Cloudflare error **521 / 522** | VM stopped, nginx stopped, or the VPC firewall blocks Cloudflare | `systemctl status nginx`; `gcloud compute instances describe devops-workshop --zone=europe-west3-a --format='value(status,tags.items)'` must show `RUNNING` and the `http-server`/`https-server` tags; `gcloud compute firewall-rules list` |
| A record points to an IP that no longer answers | the VM used an **ephemeral** external IP, which changed after a stop/start | reserve a static IP (`devops-workshop-ip`), attach it to the VM, update the A record and `DEPLOY_HOST` |
| Cloudflare error **502** (Cloudflare-branded page) | edge cannot complete the connection to the origin | check the nginx error log; is it listening on 443? |
| nginx-branded **502** | containers down (host nginx cannot reach 127.0.0.1:3000/8080) | `./deploy/deploy.sh`, `docker compose ... ps` |
| SSH to `devops.gulfheight.com` hangs | orange cloud does not proxy SSH | SSH to the IP, or use the gray cloud |
