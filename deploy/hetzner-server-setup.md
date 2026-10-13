# Hetzner Cloud server setup (Debian 13 "trixie")

This guide takes you from "no server" to "Bug Squash Arena running in Docker on a
hardened Debian server". Two companion guides finish the job:

| Order | Guide | Result |
|------:|-------|--------|
| 1 | **this guide** | Server, firewall, Docker, the app running on `127.0.0.1` |
| 2 | [`cloudflare-dns-guide.md`](cloudflare-dns-guide.md) | `devops.gulfheight.com` points to the server |
| 3 | [`letsencrypt-setup.md`](letsencrypt-setup.md) | Host nginx with HTTPS in front of the containers |

> **Tip:** create the DNS record (guide 2) as soon as you know the server's IP
> address in step 2. DNS needs a few minutes to propagate, and you can work
> through the rest of this guide in the meantime.

What we are building:

```
                 Hetzner Cloud server (Debian 13)
                +--------------------------------------------------------------+
Internet        | ufw: allow 22, 80, 443 - deny everything else                |
                |                                                              |
---:22------->  | sshd (keys only, no root login)                              |
---:80/443--->  | nginx (apt package): TLS + reverse proxy                     |
                |   |-- /api/ --> 127.0.0.1:3000 --> [backend container]       |
                |   '-- /     --> 127.0.0.1:8080 --> [frontend container]      |
                |                                                              |
                |   [backend] --(internal "data" network)--> [db container]    |
                +--------------------------------------------------------------+
```

Conventions in this guide:

| Prompt | Meaning |
|--------|---------|
| `laptop$` | a terminal on your own computer |
| `root@server#` | logged in to the server as `root` |
| `deploy@server$` | logged in to the server as the `deploy` user |

`203.0.113.10` and `2001:db8:1234::1` are documentation example addresses
(RFC 5737 / RFC 3849). Replace them with your server's real addresses.

---

## 1. Create an SSH key (once per laptop)

Skip this if `ls ~/.ssh/id_ed25519.pub` already shows a key.

```bash
laptop$ ssh-keygen -t ed25519 -C "your-name@laptop"
laptop$ cat ~/.ssh/id_ed25519.pub        # this PUBLIC key goes to Hetzner
```

Ed25519 keys are short, fast and secure. Protect the private key with a
passphrase; `ssh-agent` remembers it so you only type it once per session.
The private key (`id_ed25519`, without `.pub`) never leaves your laptop.

## 2. Create the server in the Hetzner Cloud Console

<https://console.hetzner.cloud> -> your project -> **Add Server**:

| Setting | Choice | Why |
|---------|--------|-----|
| Location | Falkenstein / Nuremberg / Helsinki | Close to Istanbul = lower latency |
| Image | **Debian 13** | Debian 12 also works, see [the differences](#debian-12-bookworm-vs-debian-13-trixie) |
| Type | **CX22** (2 x86 vCPU, 4 GB) or **CAX11** (2 Ampere Arm64 vCPU, 4 GB) | Plenty for this app. Hetzner renames plans from time to time; pick the current entry-level equivalent |
| Networking | Public IPv4 + Public IPv6 | IPv4 is needed by most visitors; IPv6 is free |
| SSH keys | **Add SSH key** -> paste `~/.ssh/id_ed25519.pub` | Hetzner installs it for `root` and sets no root password |
| Firewalls | optional, see [step 7](#7-firewall-ufw--hetzner-cloud-firewall) | Network-level firewall outside the VM |
| Name | `devops-workshop` | |

**x86 or Arm?** Both work. The `ci-main` workflow builds **multi-architecture
images** (`linux/amd64` + `linux/arm64`) and pushes them under one tag. When the
server runs `docker pull`, Docker picks the variant matching its CPU from the
image's *manifest list*. Same tag, different binaries.

Write down the IPv4 address (e.g. `203.0.113.10`) and the IPv6 address shown
in the console. Hetzner assigns a whole `/64` IPv6 network; the server itself
uses the `::1` address in it (e.g. `2001:db8:1234::1`).

## 3. First login and system update

```bash
laptop$ ssh root@203.0.113.10
```

The first connection asks *"Are you sure you want to continue connecting?"*:
SSH has never seen this server's **host key** before. Answering `yes` stores it
in `~/.ssh/known_hosts`; from now on SSH warns loudly if the key ever changes
(which could mean a man-in-the-middle). This is called *trust on first use*.

```bash
root@server# apt update && apt full-upgrade -y
root@server# apt install -y sudo curl git ufw ca-certificates
root@server# timedatectl set-timezone UTC     # servers log in UTC: comparable timestamps everywhere
root@server# reboot                            # boot into the newest kernel once
```

## 4. Create a non-root `deploy` user

Working as `root` means every typo runs with unlimited power. We create a
normal user that can become root **on purpose** with `sudo`.

```bash
laptop$ ssh root@203.0.113.10

root@server# adduser deploy                    # asks for a password - sudo will ask for it
root@server# usermod -aG sudo deploy           # members of "sudo" may use sudo

# Reuse the SSH key root was created with:
root@server# install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
root@server# install -m 600 -o deploy -g deploy /root/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
```

**Keep the root session open** and test in a **second** terminal:

```bash
laptop$ ssh deploy@203.0.113.10
deploy@server$ sudo -v && echo "sudo works"
```

Optional, but convenient - an alias in `~/.ssh/config` on your laptop:

```
Host bugsquash
    HostName 203.0.113.10
    User deploy
```

Now `ssh bugsquash` is enough.

## 5. Harden SSH

Debian's `/etc/ssh/sshd_config` starts with
`Include /etc/ssh/sshd_config.d/*.conf`, and for most settings sshd uses the
**first** value it reads. A drop-in file with a low number is therefore read
first and wins - and it survives package upgrades, unlike edits to the main file.

```bash
deploy@server$ sudo tee /etc/ssh/sshd_config.d/10-hardening.conf >/dev/null <<'EOF'
# Keys only: password guessing becomes pointless.
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
# Log in as deploy, then sudo. Root is never a direct target.
PermitRootLogin no
# Only these accounts may log in over SSH at all.
AllowUsers deploy
MaxAuthTries 3
X11Forwarding no
EOF

deploy@server$ sudo sshd -t                 # syntax check - no output means OK
deploy@server$ sudo systemctl reload ssh    # Debian's service is called "ssh"
deploy@server$ sudo sshd -T | grep -E '^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication|allowusers) '
```

The last command prints the **effective** configuration. If a value is not
what you wrote, another file in `sshd_config.d/` (for example one written by
cloud-init) was read first - rename yours to sort earlier.

Test again from a **new** terminal (`ssh deploy@...` must work,
`ssh root@...` must fail with *Permission denied*) before closing the root
session.

> Optional: `fail2ban` bans IPs after repeated failed logins. With password
> authentication disabled it mostly reduces log noise. Debian logs to the
> systemd journal, so configure the jail with `backend = systemd`.

## 6. Automatic security updates

```bash
deploy@server$ sudo apt install -y unattended-upgrades apt-listchanges
deploy@server$ sudo dpkg-reconfigure -plow unattended-upgrades    # answer "Yes"
```

This writes `/etc/apt/apt.conf.d/20auto-upgrades`, which enables the daily
systemd timers `apt-daily.timer` (download) and `apt-daily-upgrade.timer`
(install). By default only packages from **Debian-Security** are installed
automatically - not Docker from docker.com, which you upgrade deliberately
with `sudo apt upgrade`.

Kernel and libc updates need a reboot. Let the server do it at night:

```bash
deploy@server$ sudo tee /etc/apt/apt.conf.d/52unattended-upgrades-local >/dev/null <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:00";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF

deploy@server$ systemctl list-timers 'apt-daily*'
deploy@server$ sudo unattended-upgrade --dry-run --debug 2>&1 | tail -n 20
```

A nightly reboot is safe for our stack: the Docker daemon is enabled at boot,
and every service in `docker-compose.prod.yml` has `restart: unless-stopped`,
so the containers come back on their own.

## 7. Firewall: ufw + Hetzner Cloud Firewall

### 7.1 ufw on the server

```bash
deploy@server$ sudo ufw default deny incoming
deploy@server$ sudo ufw default allow outgoing
deploy@server$ sudo ufw allow OpenSSH        # ALWAYS before "enable", or you lock yourself out
deploy@server$ sudo ufw allow 80/tcp         # HTTP: Let's Encrypt challenges + redirect to HTTPS
deploy@server$ sudo ufw allow 443/tcp        # HTTPS
deploy@server$ sudo ufw enable
deploy@server$ sudo ufw status verbose
```

ufw is a friendly front end for the kernel's netfilter (on Debian 13 it
writes nftables rules through `iptables-nft`). IPv6 rules are created
automatically (`IPV6=yes` in `/etc/default/ufw`).

### 7.2 Docker bypasses ufw for published ports

This is one of the most common security mistakes with Docker. When a
container publishes a port (`ports: "3000:3000"`), Docker adds its **own**
netfilter rules:

```
packet from the internet to 203.0.113.10:3000
   |
   v
nat/PREROUTING --> DOCKER chain: DNAT to 172.18.0.3:3000      (Docker's rule)
   |
   v   routing decision: the destination is now a CONTAINER, not this host
   |
filter/FORWARD --> DOCKER-USER / DOCKER chains: ACCEPT
   |
   v
container  <-- ufw's rules live in the INPUT chain and were NEVER consulted
```

So `sudo ufw deny 3000` would change **nothing**: the API would be open to the
whole internet. That is why `docker-compose.prod.yml` publishes every port on
**loopback only**:

```yaml
ports:
  - "127.0.0.1:3000:3000"   # only processes on this server (host nginx) can connect
```

Verify it once the app is running (step 13):

```bash
deploy@server$ sudo ss -tlnp | grep -E ':(3000|8080)\b'     # must show 127.0.0.1, not 0.0.0.0
laptop$ curl -m 5 http://203.0.113.10:3000/api/health          # must time out / be refused
```

(To filter traffic to published ports deliberately, Docker provides the
`DOCKER-USER` chain. Binding to `127.0.0.1` is simpler and easier to reason about.)

### 7.3 Optional: Hetzner Cloud Firewall (defence in depth)

A Hetzner Cloud Firewall filters packets in Hetzner's network **before** they
reach your VM, so nothing running inside the server - Docker included - can
open a hole in it. Console -> **Firewalls** -> **Create Firewall**:

| Direction | Protocol | Port | Source |
|-----------|----------|------|--------|
| Inbound | TCP | 22 | Any (see note) |
| Inbound | TCP | 80 | Any IPv4, Any IPv6 |
| Inbound | TCP | 443 | Any IPv4, Any IPv6 |
| Inbound | ICMP | - | Any IPv4, Any IPv6 (ping, path-MTU discovery) |

Leave **outbound** rules empty (= everything allowed; once you add a single
outbound rule, all other outbound traffic is blocked). Then **Apply to** your
server.

> Restricting port 22 to your home IP is tempting, but GitHub Actions
> runners connect from constantly changing addresses - with auto-deploy
> (step 14) port 22 must stay reachable from anywhere. Key-only SSH makes
> that safe.

## 8. Install Docker Engine (official docker.com repository)

Debian's own `docker.io` package is older and packaged differently from the
upstream releases that the Docker documentation (and this course) assume. Use
Docker's repository:

```bash
# 1. Docker's GPG key: apt refuses packages from this repo not signed with it.
deploy@server$ sudo install -m 0755 -d /etc/apt/keyrings
deploy@server$ sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
deploy@server$ sudo chmod a+r /etc/apt/keyrings/docker.asc

# 2. The repository, in the deb822 ".sources" format. $VERSION_CODENAME is
#    "trixie" on Debian 13 and "bookworm" on Debian 12 - same commands for both.
deploy@server$ sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: $(. /etc/os-release && echo "$VERSION_CODENAME")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

# 3. Install the engine, the CLI, containerd and the buildx/compose plugins.
deploy@server$ sudo apt update
deploy@server$ sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# 4. Smoke test
deploy@server$ sudo docker run --rm hello-world
deploy@server$ docker compose version
```

(If you ever installed `docker.io`, `docker-compose`, `podman-docker`,
`containerd` or `runc` from Debian before, remove them first - they conflict.)

### Let `deploy` use Docker without sudo

```bash
deploy@server$ sudo usermod -aG docker deploy
deploy@server$ exit                      # group membership is read at login
laptop$ ssh deploy@203.0.113.10
deploy@server$ docker info --format 'cgroup v{{.CgroupVersion}}, driver {{.CgroupDriver}}'
```

The output should be `cgroup v2, driver systemd`: the memory/CPU limits in
`docker-compose.prod.yml` are enforced by the kernel's **cgroup v2** controllers.

> **Security note:** the `docker` group is equivalent to root. Anyone in it can
> run `docker run -v /:/host ...` and edit any file on the server. Only add
> trusted accounts. (Rootless Docker avoids this at the cost of some features.)

### Optional: keep containers running while the Docker daemon restarts

```bash
deploy@server$ echo '{ "live-restore": true }' | sudo tee /etc/docker/daemon.json
deploy@server$ sudo systemctl restart docker
```

With `live-restore`, upgrading the `docker-ce` package restarts `dockerd`
without killing your containers: they are child processes of
`containerd-shim`, not of `dockerd`, so they can outlive it.

## 9. Install nginx (on the host, not in Docker)

```bash
deploy@server$ sudo apt install -y nginx
deploy@server$ nginx -v                    # Debian 13: 1.26.x  |  Debian 12: 1.22.1
deploy@server$ systemctl status nginx --no-pager
```

Why on the host and not in a container? The host nginx owns ports 80/443 and
the TLS certificates, and certbot manages both directly. The application
containers can be replaced on every deploy without ever touching TLS.

Optionally remove Debian's "Welcome to nginx" default site, so requests for
unknown host names are not answered with a placeholder page:

```bash
deploy@server$ sudo rm /etc/nginx/sites-enabled/default    # a symlink; the original stays in sites-available
deploy@server$ sudo nginx -t && sudo systemctl reload nginx
```

The site configuration and the TLS certificate come in
[`letsencrypt-setup.md`](letsencrypt-setup.md) - after the app runs (step 13)
and DNS points to the server.

## 10. Clone the repository to `/opt/devops-workshop`

`/opt` is the conventional place for self-contained add-on software. The
`deploy` user owns the directory, so `git pull` and `deploy.sh` never need sudo.

```bash
deploy@server$ sudo install -d -o deploy -g deploy /opt/devops-workshop
deploy@server$ git clone https://github.com/<your-account>/<your-repo>.git /opt/devops-workshop
deploy@server$ cd /opt/devops-workshop
```

**Private repository?** Create a read-only *deploy key* instead of storing
your personal credentials on the server:

```bash
deploy@server$ ssh-keygen -t ed25519 -f ~/.ssh/github_deploy -N "" -C "devops-workshop deploy key"
deploy@server$ cat ~/.ssh/github_deploy.pub
# GitHub -> repository -> Settings -> Deploy keys -> Add deploy key (leave "Allow write access" OFF)
deploy@server$ GIT_SSH_COMMAND="ssh -i ~/.ssh/github_deploy" \
    git clone git@github.com:<your-account>/<your-repo>.git /opt/devops-workshop
deploy@server$ git -C /opt/devops-workshop config core.sshCommand "ssh -i ~/.ssh/github_deploy"
```

Never edit tracked files on the server: `git pull --ff-only` (used by the
CI auto-deploy) refuses to run when the working tree has diverged. Server-only
configuration belongs in `.env.prod`, which is git-ignored.

## 11. Create `.env.prod` with real secrets

```bash
deploy@server$ cd /opt/devops-workshop
deploy@server$ cp .env.prod.example .env.prod
deploy@server$ chmod 600 .env.prod             # readable by deploy only

# Generate two independent 256-bit secrets straight into the file:
deploy@server$ sed -i \
    -e "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 32)/" \
    -e "s/^JWT_SECRET=.*/JWT_SECRET=$(openssl rand -hex 32)/" \
    .env.prod

deploy@server$ nano .env.prod                  # set DOCKER_HUB_USERNAME, review the rest
```

| Variable | Value |
|----------|-------|
| `DOCKER_HUB_USERNAME` | The Docker Hub account `ci-main` pushes to (**required**) |
| `IMAGE_TAG` | `latest`, or a pinned `sha-1a2b3c4` |
| `POSTGRES_PASSWORD` | Generated above (**required**) |
| `JWT_SECRET` | Generated above (**required**) |
| `COOKIE_SECURE` | `true` - the site is served over HTTPS |

Things worth knowing:

* `POSTGRES_PASSWORD` is only applied when the database volume is **created**
  (first start). Changing it later does not change the password stored inside
  the existing database - you would also have to run `ALTER USER` in `psql`.
* Changing `JWT_SECRET` logs every user out (their tokens no longer verify).
* Save a copy of `.env.prod` in your password manager. It is not in Git, so it
  is not backed up anywhere else.

## 12. Docker Hub login (optional)

* **Public images** (the default for a free Docker Hub repository): no login
  needed. Anonymous pulls are rate-limited per IP address, which is fine for
  occasional deploys.
* **Private images**, or if you hit the rate limit: log in with a
  **read-only personal access token** (Docker Hub -> Account settings ->
  Personal access tokens), never your password:

```bash
deploy@server$ docker login -u <your-dockerhub-username>    # paste the token as password
```

The credentials end up base64-encoded - **not encrypted** - in
`~/.docker/config.json`. That is why the token should be read-only.

## 13. First deploy

```bash
deploy@server$ cd /opt/devops-workshop
deploy@server$ ./deploy/deploy.sh
```

The script validates the configuration, pulls the images, starts
`db -> backend -> frontend` in dependency order, waits for every healthcheck,
and smoke-tests the loopback ports. Check it yourself:

```bash
deploy@server$ curl -s http://127.0.0.1:3000/api/health; echo
{"status":"ok","db":"up","version":"1a2b3c4","uptime":12}
deploy@server$ docker compose -f docker-compose.prod.yml --env-file .env.prod ps
deploy@server$ docker stats --no-stream        # memory usage vs. the cgroup limits
```

The app now runs - but only on `127.0.0.1`. Continue with
[`cloudflare-dns-guide.md`](cloudflare-dns-guide.md) (if the DNS record does
not exist yet) and then [`letsencrypt-setup.md`](letsencrypt-setup.md) to put
the host nginx with HTTPS in front of it.

## 14. Optional: automatic deploys from GitHub Actions

The `deploy` job in `.github/workflows/ci-main.yml` SSHes into the server
after every successful build on `main` and runs:

```bash
cd /opt/devops-workshop && git pull --ff-only && ./deploy/deploy.sh sha-<short-commit>
```

It deploys the **immutable** `sha-...` tag of the commit it just built, so
production always runs exactly the tested image, and a rollback is
`./deploy/deploy.sh sha-<older-commit>`.

### 14.1 A dedicated key pair for CI

Never give CI your personal key - a dedicated key can be revoked on its own.

```bash
laptop$ ssh-keygen -t ed25519 -f ~/.ssh/bugsquash_ci -N "" -C "github-actions deploy"
laptop$ cat ~/.ssh/bugsquash_ci.pub
```

Append the public key on the server, prefixed with `restrict`, which
disables port/agent/X11 forwarding and terminal allocation for this key.
Running a command - all CI needs - still works:

```bash
deploy@server$ echo 'restrict ssh-ed25519 AAAA...paste...the...key github-actions deploy' >> ~/.ssh/authorized_keys
```

### 14.2 Pin the server's host key

Without it, the workflow falls back to trust-on-first-use (and prints a
warning). Fetch the host key and compare its fingerprint with the one the
server reports about itself:

```bash
laptop$ ssh-keyscan -t ed25519 203.0.113.10 > bugsquash_known_hosts
laptop$ ssh-keygen -lf bugsquash_known_hosts
deploy@server$ ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub   # must print the SAME fingerprint
```

### 14.3 GitHub settings

Repository -> **Settings** -> **Secrets and variables** -> **Actions**:

| Kind | Name | Value |
|------|------|-------|
| Secret | `HETZNER_HOST` | `203.0.113.10` - the **IP**, not the domain (a Cloudflare-proxied name does not forward SSH) |
| Secret | `HETZNER_USER` | `deploy` |
| Secret | `HETZNER_SSH_KEY` | full content of `~/.ssh/bugsquash_ci` (the **private** key, including the BEGIN/END lines) |
| Secret | `HETZNER_KNOWN_HOSTS` | content of `bugsquash_known_hosts` (optional, recommended) |
| Variable | `ENABLE_AUTO_DEPLOY` | `true` |
| Variable | `DEPLOY_PATH` | optional, defaults to `/opt/devops-workshop` |

The job runs in the GitHub **environment** `production`. Under
**Settings -> Environments -> production** you can add *required reviewers*:
every deploy then waits for a manual click - a simple approval gate.

Push a commit to `main` and watch **Actions**: build -> deploy -> the
footer of <https://devops.gulfheight.com> shows the new commit hash.

---

## Day-2 operations cheat sheet

```bash
cd /opt/devops-workshop
alias dc='docker compose -f docker-compose.prod.yml --env-file .env.prod'

dc ps                                   # state + health of each container
dc logs -f --tail=100 backend           # follow the backend logs
docker stats                            # live CPU / memory per container (cgroups!)
./deploy/deploy.sh sha-1a2b3c4          # deploy or roll back to an exact build
dc restart backend                      # SIGTERM -> graceful shutdown -> start again
dc exec db psql -U bugsquash bugsquash  # SQL shell inside the db container
dc exec -T db pg_dump -U bugsquash bugsquash | gzip > ~/backup-$(date +%F).sql.gz
docker system df                        # disk used by images, containers, volumes
sudo tail -f /var/log/nginx/devops.gulfheight.com.access.log
```

## Debian 12 "bookworm" vs Debian 13 "trixie"

Everything in this guide works on both. The differences you may notice:

| Topic | Debian 13 "trixie" | Debian 12 "bookworm" |
|-------|--------------------|----------------------|
| nginx | 1.26 - `listen 443 ssl;` + `http2 on;` | 1.22 - `http2 on;` is unknown; use `listen 443 ssl http2;` (commented in the nginx config) |
| Docker apt suite | `trixie` | `bookworm` (picked automatically from `/etc/os-release`) |
| Debian apt sources | deb822 format: `/etc/apt/sources.list.d/debian.sources` | Classic `/etc/apt/sources.list` (cloud images may already use deb822) |
| Linux kernel | 6.12 LTS | 6.1 LTS |
| OpenSSH | 10.x (DSA keys removed) | 9.2 |
| `/tmp` | RAM-backed `tmpfs` by default | Regular directory on disk |
| cgroups | v2 (unified) | v2 (unified) |
