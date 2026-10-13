# Google Cloud VM setup (Compute Engine, Debian 13 "trixie")

This guide takes you from "an empty Google Cloud account" to "Bug Squash
Arena running in Docker on a hardened Debian VM in Google Compute Engine". It
is part of the workshop described in the [README](../README.md). Two companion
guides finish the job:

| Order | Guide | Result |
|------:|-------|--------|
| 1 | **this guide** | Project, static IP, firewall rules, VM, Docker, the app running on `127.0.0.1` |
| 2 | [`cloudflare-dns-guide.md`](./cloudflare-dns-guide.md) | `devops.gulfheight.com` points to the VM's static IP |
| 3 | [`letsencrypt-setup.md`](./letsencrypt-setup.md) | Host nginx with HTTPS in front of the containers |

> **Tip:** create the DNS record (guide 2) as soon as you have reserved the
> static IP in step 2. The IP never changes after that, DNS needs a few
> minutes to propagate, and you can work through the rest of this guide in
> the meantime.

The steps fall into four phases:

| Steps | Where you work | What happens |
|-------|----------------|--------------|
| 1-4 | your laptop (`gcloud`) | Google Cloud resources: project, static IP, firewall rules, VM |
| 5-9 | inside the VM | users, SSH, updates, Docker, nginx |
| 10-14 | inside the VM | the application: clone, secrets, deploy, CI auto-deploy |
| 15, Day-2, Troubleshooting | both | running costs, cleanup, everyday commands, fixes |

What we are building:

```
                  Google Cloud project
                 +----------------------------------------------------------------------+
                 | VPC network "default" - firewall enforced by Google, OUTSIDE the VM  |
Internet         |   allow tcp:22 (default-allow-ssh), tcp:80 + tcp:443                 |
                 |   (allow-http-https), ICMP; everything else is dropped               |
static external  |                                                                      |
IP 203.0.113.10  |   +--------------------------------------------------------------+   |
                 |   | VM "devops-workshop" (e2-small, Debian 13)                   |   |
---:22------->   |   |  sshd (keys only, no root login)                             |   |
---:80/443--->   |   |  nginx (apt package): TLS + reverse proxy                    |   |
                 |   |    |-- /api/ --> 127.0.0.1:3000 --> [backend container]      |   |
                 |   |    '-- /     --> 127.0.0.1:8080 --> [frontend container]     |   |
                 |   |                                                              |   |
                 |   |  [backend] --(internal "data" network)--> [db container]     |   |
                 |   +--------------------------------------------------------------+   |
                 +----------------------------------------------------------------------+
```

Conventions in this guide:

| Prompt | Meaning |
|--------|---------|
| `laptop$` | a terminal on your own computer **or** in Cloud Shell, with the `gcloud` CLI |
| `you@server$` | logged in to the VM with `gcloud compute ssh` as your own admin account |
| `deploy@server$` | logged in to the VM as the `deploy` user |

`203.0.113.10` is a documentation example address (RFC 5737). Replace it with
the static IP you reserve in step 2.

Every `gcloud` command below uses these shell variables. Set them in **every
new terminal** (and every new Cloud Shell session) - shell variables die with
the terminal:

```bash
laptop$ PROJECT_ID=devops-workshop-12345   # globally unique: 6-30 chars, lowercase letters, digits, hyphens
laptop$ REGION=europe-west3                # Frankfurt - low latency from Istanbul; any region works
laptop$ ZONE=europe-west3-a                # one of the region's zones (a, b, c)
```

A **region** is a geographic area (`europe-west3` = Frankfurt). Each region
contains several **zones**: separate data-centre locations with independent
power, cooling and networking, so one zone failing does not take down the
others. Some resources are **regional** (the static IP), others are **zonal**
(the VM and its disk) - that is why some commands take `--region` and others
`--zone`.

---

## 1. Prerequisites: project, billing and the gcloud CLI

### 1.1 A Google Cloud account with billing

Sign in at <https://console.cloud.google.com> with a Google account. New
customers get the **Free Trial**: credit (currently US$300, valid for 90
days) that pays for everything in this guide. Google asks for a payment method
to verify your identity, but you are not charged during the trial. When it
ends, you have to upgrade to a paid account explicitly; otherwise your
resources are stopped and later deleted.

> A university-managed Google account may not be allowed to create projects
> or billing accounts. If `gcloud projects create` below fails with a
> permission error, use a personal Google account or ask your instructor.

### 1.2 The gcloud CLI

Pick one:

* **Cloud Shell** (zero install): the `>_` icon at the top right of the
  console opens a Linux terminal in the browser with `gcloud` installed and
  already logged in. Its home directory persists between sessions.
* **Local install**: follow <https://cloud.google.com/sdk/docs/install>, then:

```bash
laptop$ gcloud init                 # log in in the browser, create a "configuration"
laptop$ gcloud auth list            # which Google account is active?
laptop$ gcloud version
```

### 1.3 Project, billing link and the Compute Engine API

A **project** is the container for everything we create: resources, access
rights (IAM) and the bill. Deleting the project deletes everything in it,
which makes cleanup after the course easy (step 15).

```bash
# Create the project (skip if you made one in the console):
laptop$ gcloud projects create "$PROJECT_ID" --name="DevOps Workshop"

# Link it to your billing account. Compute Engine needs one, even on the free trial.
laptop$ gcloud billing accounts list                        # copy the ACCOUNT_ID
laptop$ gcloud billing projects link "$PROJECT_ID" --billing-account=0X0X0X-0X0X0X-0X0X0X

# Defaults for this configuration. Unlike shell variables, these persist.
laptop$ gcloud config set project "$PROJECT_ID"
laptop$ gcloud config set compute/region "$REGION"
laptop$ gcloud config set compute/zone "$ZONE"

# Google APIs are switched OFF per project until you enable them.
laptop$ gcloud services enable compute.googleapis.com      # takes a minute the first time
```

Enabling the Compute Engine API also creates the project's `default` VPC
network with a few firewall rules - we use both in step 3.

> **Console:** project picker at the top -> **New project**; **Billing** ->
> **Link a billing account**; **APIs & Services** -> **Enable APIs and
> services** -> "Compute Engine API" -> **Enable**.

## 2. Reserve a static external IP

Every VM gets a private **internal** IP in the VPC network (`10.x.x.x`). For
traffic from the internet it also needs an **external** IP, and by default
that one is **ephemeral**: it is released when the VM stops, and the VM gets a
*different* address when it starts again. Your Cloudflare A record would then
point at nothing - or, worse, at a stranger's VM that received your old
address. The `DEPLOY_HOST` secret for CI (step 14) would break the same way.

A **static** external IP is reserved in your project until you release it,
independent of any VM:

```bash
laptop$ gcloud compute addresses create devops-workshop-ip --region="$REGION"

laptop$ gcloud compute addresses describe devops-workshop-ip --region="$REGION" --format="value(address)"
203.0.113.10

laptop$ gcloud compute addresses list      # STATUS: RESERVED now, IN_USE once the VM has it
```

Write the address down: it goes into the Cloudflare A record
([`cloudflare-dns-guide.md`](./cloudflare-dns-guide.md)) and into the
`DEPLOY_HOST` secret (step 14.3).

Things worth knowing:

* Static external IPs are **regional**: the VM must be created in the same
  region (`$REGION`), but any of its zones works.
* Google bills external IPv4 addresses. A reserved address that is **not
  attached** to a running VM is billed even though nothing uses it - release
  it when you are done (step 15).
* IPv4 only: this VM gets no external IPv6 address (that needs a dual-stack
  subnet, which the `default` network does not have). Create **no AAAA
  record** for `devops`.

> **Console:** **VPC network** -> **IP addresses** -> **Reserve external
> static IP address**: name `devops-workshop-ip`, IPv4, type **Regional**,
> region `europe-west3`.

## 3. Open ports 80 and 443 (VPC firewall rules)

The **VPC firewall** is enforced by Google's network at each VM's virtual
network card - outside the guest operating system. Nothing running *inside*
the VM (a misconfigured service, Docker, an attacker with root) can open a
hole in it. The rules are **stateful**: when an inbound connection is
allowed, its reply packets are allowed automatically.

Every VPC network has two *implied* rules: **deny all ingress** and **allow
all egress**. The `default` network adds a few pre-populated rules with
priority 65534 (lower number = higher priority, so almost any rule you add
takes precedence over them):

| Rule | Allows | From | Comment |
|------|--------|------|---------|
| `default-allow-ssh` | tcp:22 | `0.0.0.0/0` | SSH for `gcloud compute ssh`, you, and CI |
| `default-allow-icmp` | ICMP | `0.0.0.0/0` | `ping`, path-MTU discovery |
| `default-allow-internal` | all TCP/UDP ports + ICMP | `10.128.0.0/9` | VM-to-VM traffic inside the network |
| `default-allow-rdp` | tcp:3389 | `0.0.0.0/0` | Windows Remote Desktop - unused here |

HTTP and HTTPS are **not** allowed yet. We add one rule for both. Instead of
applying it to every VM in the network, it targets VMs carrying the **network
tags** `http-server` or `https-server` - labels we put on the VM in step 4:

```bash
laptop$ gcloud compute firewall-rules create allow-http-https \
    --network=default \
    --direction=INGRESS \
    --allow=tcp:80,tcp:443 \
    --source-ranges=0.0.0.0/0 \
    --target-tags=http-server,https-server \
    --description="HTTP (Let's Encrypt + redirect) and HTTPS to the devops-workshop VM"

laptop$ gcloud compute firewall-rules list
```

* Port **80**: Let's Encrypt's HTTP-01 challenge and the redirect to HTTPS.
* Port **443**: HTTPS.
* Optional tidy-up: nothing listens on 3389, but an unneeded rule is still
  attack surface on paper:
  `gcloud compute firewall-rules delete default-allow-rdp`.

> **Console:** **VPC network** -> **Firewall** -> **Create firewall rule**:
> name `allow-http-https`, network `default`, direction **Ingress**, action
> **Allow**, targets **Specified target tags** `http-server`, `https-server`,
> source IPv4 ranges `0.0.0.0/0`, protocols and ports: TCP `80,443`.
> (Ticking **Allow HTTP/HTTPS traffic** while creating a VM in the console
> adds the same tags and creates the equivalent rules `default-allow-http` /
> `default-allow-https`. Duplicates are harmless.)

### Port 22: open to the internet, or only through IAP?

`default-allow-ssh` accepts SSH from **anywhere**. That is acceptable because
the VM only allows **key-based** logins (step 7): password guessing is
pointless. And we need it: the auto-deploy in step 14 runs on
**GitHub-hosted runners**, which connect from constantly changing IP
addresses - port 22 has to be reachable from the whole internet for CI to
SSH in.

If you deploy **by hand only**, you can close port 22 to the internet and let
Google's **Identity-Aware Proxy (IAP)** carry your SSH sessions instead. IAP
checks your Google identity (IAM) first, then connects to the VM from a fixed
Google range:

```bash
laptop$ gcloud compute firewall-rules create allow-ssh-from-iap \
    --network=default \
    --direction=INGRESS \
    --allow=tcp:22 \
    --source-ranges=35.235.240.0/20
laptop$ gcloud compute firewall-rules delete default-allow-ssh
laptop$ gcloud compute ssh devops-workshop --zone="$ZONE" --tunnel-through-iap
```

The price: GitHub Actions can no longer deploy, and a plain
`ssh deploy@203.0.113.10` from your laptop stops working too. Project owners
may use IAP right away; other accounts need the IAM role *IAP-secured Tunnel
User* (`roles/iap.tunnelResourceAccessor`).

### Why no ufw - and why Docker's ports are bound to `127.0.0.1`

We do **not** run a host firewall (ufw, firewalld) on the VM: the VPC
firewall is the network firewall, and it is the stronger one because it sits
outside the VM. But there is a Docker detail every Docker user must know -
**published container ports bypass host firewalls**.

When a container publishes a port (`ports: "3000:3000"`), Docker adds its
**own** netfilter rules:

```
packet from the internet to the VM, port 3000
   |
   v
nat/PREROUTING --> DOCKER chain: DNAT to 172.18.0.3:3000      (Docker's rule)
   |
   v   routing decision: the destination is now a CONTAINER, not this host
   |
filter/FORWARD --> DOCKER-USER / DOCKER chains: ACCEPT
   |
   v
container  <-- a host firewall's rules (ufw, firewalld) live in the INPUT chain
               and were NEVER consulted
```

So on a server that relies on ufw, `sudo ufw deny 3000` would change
**nothing**: the API would be open to the whole internet. That is why
`docker-compose.prod.yml` publishes every port on **loopback only**:

```yaml
ports:
  - "127.0.0.1:3000:3000"   # only processes on this VM (the host nginx) can connect
```

Together with the VPC firewall that gives **two independent layers**:

1. The **VPC firewall** only lets tcp:22, 80 and 443 reach the VM at all.
2. **Loopback binding**: even if someone later adds a VPC rule for port 3000
   (one console checkbox too many), nothing listens on the VM's network
   interface on that port.

Both layers must fail before the API is exposed directly. Step 13 shows how
to verify both.

## 4. Create the VM

```bash
laptop$ gcloud compute instances create devops-workshop \
    --zone="$ZONE" \
    --machine-type=e2-small \
    --image-family=debian-13 \
    --image-project=debian-cloud \
    --boot-disk-size=20GB \
    --boot-disk-type=pd-balanced \
    --address=devops-workshop-ip \
    --tags=http-server,https-server \
    --metadata=enable-guest-attributes=TRUE \
    --no-service-account \
    --no-scopes

laptop$ gcloud compute instances list     # STATUS RUNNING, EXTERNAL_IP = your static IP
laptop$ gcloud compute addresses list     # devops-workshop-ip is now IN_USE
```

| Flag | Why |
|------|-----|
| `--machine-type=e2-small` | 2 shared vCPUs, 2 GB RAM - see the table below |
| `--image-family=debian-13`, `--image-project=debian-cloud` | An image **family** always resolves to the newest image in it, so you start with current packages. `debian-cloud` is the public project where the Debian images are published. Debian 12 also works, see [the differences](#debian-12-bookworm-vs-debian-13-trixie) |
| `--boot-disk-size=20GB` | The image's default is 10 GB - too tight once Docker keeps a few image versions for rollbacks, plus Postgres data and logs |
| `--boot-disk-type=pd-balanced` | SSD-backed persistent disk, a good price/performance middle ground (`pd-standard` is HDD-backed: cheaper, slower) |
| `--address=devops-workshop-ip` | Attaches the static IP from step 2 (by name; it must be in the VM's region) |
| `--tags=http-server,https-server` | Network tags - this is what makes the firewall rule from step 3 apply to this VM |
| `--metadata=enable-guest-attributes=TRUE` | Lets the VM publish its SSH **host keys** to Google through the metadata server. `gcloud compute ssh` then verifies the host key instead of trusting it blindly, and you can pin it for CI (step 14.2). Must be set **before the first boot** |
| `--no-service-account`, `--no-scopes` | No Google Cloud identity for the VM. Our app calls no Google APIs. Containers can reach the VM's metadata server (`169.254.169.254`), and with the default service account a compromised container could fetch an access token for your project from there. No account, no token |

A **persistent disk** is network-attached block storage: it lives
independently of the VM's CPU and RAM, survives stop/start, and is deleted
together with the VM (unless you say otherwise).

### Which machine type?

| Machine type | vCPUs | RAM | Verdict |
|--------------|-------|-----|---------|
| `e2-micro` | 2 shared (0.25 sustained) | 1 GB | **Always Free** tier, but only in `us-west1`, `us-central1` and `us-east1`. Works only with a swap file and is tight - see the variant below |
| `e2-small` | 2 shared (0.5 sustained) | 2 GB | **Recommended.** The VM only pulls and runs images; CI builds them |
| `e2-medium` | 2 shared (1 sustained) | 4 GB | Headroom, e.g. for a monitoring stack later |

**Shared-core** E2 types get a fraction of two vCPUs on average and may
**burst** to 100% for short periods (longer the less they were used before).
That fits a small web app: mostly idle, short spikes. The memory limits in
`docker-compose.prod.yml` add up to db 512M + backend 256M + frontend 64M =
832 MB - before the OS, dockerd, containerd and nginx. That is comfortable in
2 GB and does not fit in 1 GB without swap.

You can change the machine type later (the VM must be stopped):

```bash
laptop$ gcloud compute instances stop devops-workshop --zone="$ZONE"
laptop$ gcloud compute instances set-machine-type devops-workshop --zone="$ZONE" --machine-type=e2-medium
laptop$ gcloud compute instances start devops-workshop --zone="$ZONE"     # same static IP
```

### Variant: e2-micro on the Always Free tier

The Always Free tier covers one non-preemptible `e2-micro` VM and 30 GB of
**standard** persistent disk per month, in three US regions only (higher
latency from Turkey). Set the variables **before** step 2, so the static IP is
reserved in the same region:

```bash
laptop$ REGION=us-central1
laptop$ ZONE=us-central1-a
```

In step 4, change these flags: `--machine-type=e2-micro`,
`--boot-disk-type=pd-standard`, `--boot-disk-size=30GB`. Then add the swap
file from [step 5](#e2-micro-only-add-a-swap-file). Check the free tier page
(<https://cloud.google.com/free>) for what is still billed, such as the
external IP and outbound traffic.

### Variant: Arm (Tau T2A or Axion C4A)

**x86 or Arm?** Both work. The `ci-main` workflow builds **multi-architecture
images** (`linux/amd64` + `linux/arm64`) and pushes them under one tag. When
the VM runs `docker pull`, Docker picks the variant matching its CPU from the
image's *manifest list*. Same tag, different binaries.

Arm machine types exist only in some zones. Check first, and pick a `ZONE` (and
a `REGION` for step 2) from the list:

```bash
laptop$ gcloud compute machine-types list --filter="name=t2a-standard-1" --format="value(zone)"
laptop$ gcloud compute machine-types list --filter="name=c4a-standard-1" --format="value(zone)"
```

| Series | Flags to change in step 4 |
|--------|---------------------------|
| Tau T2A (Ampere Altra) | `--machine-type=t2a-standard-1 --image-family=debian-13-arm64` (1 vCPU, 4 GB; `pd-balanced` works) |
| Axion C4A (Google's own Arm CPU) | `--machine-type=c4a-standard-1 --image-family=debian-13-arm64 --boot-disk-type=hyperdisk-balanced` (1 vCPU, 4 GB; C4A supports only Hyperdisk, not persistent disk) |

### Debian 12 "bookworm" vs Debian 13 "trixie"

Everything in this guide works on both (`--image-family=debian-12`). The
differences you may notice:

| Topic | Debian 13 "trixie" | Debian 12 "bookworm" |
|-------|--------------------|----------------------|
| nginx | 1.26 - `listen 443 ssl;` + `http2 on;` | 1.22 - `http2 on;` is unknown; use `listen 443 ssl http2;` (commented in the nginx config) |
| Docker apt suite | `trixie` | `bookworm` (picked automatically from `/etc/os-release`) |
| Debian apt sources | deb822 format: `/etc/apt/sources.list.d/debian.sources` | Classic `/etc/apt/sources.list` (cloud images may already use deb822) |
| Linux kernel | 6.12 LTS (`-cloud-amd64` / `-cloud-arm64` flavour on Compute Engine) | 6.1 LTS (also the cloud flavour) |
| OpenSSH | 10.x (DSA keys removed) | 9.2 |
| `/tmp` | RAM-backed `tmpfs` by default | Regular directory on disk |
| cgroups | v2 (unified) | v2 (unified) |

> **Console:** **Compute Engine** -> **VM instances** -> **Create instance**.
> Name `devops-workshop`, region `europe-west3`, zone `europe-west3-a`,
> series **E2**, type **e2-small**. *OS and storage*: Debian GNU/Linux 13
> (trixie), Balanced persistent disk, 20 GB. *Networking*: network tags
> `http-server`, `https-server`; network interface -> external IPv4 address
> -> `devops-workshop-ip`. *Security*: service account none.
> *Advanced* -> metadata: key `enable-guest-attributes`, value `TRUE`. The
> console layout changes from time to time; the CLI command above is the
> reference.

## 5. First login and system update

```bash
laptop$ gcloud compute ssh devops-workshop --zone="$ZONE"
```

What happens on the very first run:

1. gcloud creates a key pair `~/.ssh/google_compute_engine` on your laptop
   (it asks for a passphrase - set one).
2. It adds the public key to the **project metadata** (`ssh-keys`). Keys
   there work on every VM in the project.
3. The **guest agent** on the VM (`google-guest-agent`, preinstalled) notices
   the new key within seconds, creates a Linux user named after your local
   login name, and adds it to the `google-sudoers` group: **passwordless
   sudo**.
4. gcloud reads the VM's host keys from the guest attributes (step 4) and
   stores them in `~/.ssh/google_compute_known_hosts`, so it can verify the
   VM's identity instead of trusting whatever answers on port 22.

Your **Google account** (via IAM) is now the key to root on this VM. Protect
it with 2-step verification.

> **OS Login:** if OS Login is on (metadata `enable-oslogin=TRUE`, often
> enforced by an organisation policy), gcloud stores the key in your Google
> account's OS Login profile instead of the project metadata, and your Linux
> user name is derived from your e-mail address (e.g. `jane_example_com`).
> Sudo then requires the IAM role `roles/compute.osAdminLogin`. Everything
> else in this guide works the same.

Update the system:

```bash
you@server$ sudo apt update && sudo apt full-upgrade -y
you@server$ sudo apt install -y curl git ca-certificates
you@server$ timedatectl | grep 'Time zone'     # Compute Engine images run in UTC: comparable timestamps everywhere
you@server$ df -h /                            # ~20G: the root partition grew to the disk size on first boot
you@server$ sudo reboot                        # boot into the newest kernel once
```

Wait half a minute, then log in again and look around:

```bash
laptop$ gcloud compute ssh devops-workshop --zone="$ZONE"
you@server$ uname -r
6.12.48+deb13-cloud-amd64
you@server$ ip -4 -brief addr show            # only a private 10.x.x.x address - no public IP here!
you@server$ curl -s -H 'Metadata-Flavor: Google' \
    http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip; echo
203.0.113.10
```

* `-cloud-amd64`: Debian's **cloud kernel** flavour. It leaves out drivers
  for physical hardware (sound, Wi-Fi, most USB devices) and keeps what a VM
  needs (virtio, NVMe, gVNIC). Everything Docker needs (overlayfs, cgroup v2,
  nftables) is included.
* The VM's network card only knows the **internal** IP. Google's network
  translates between the external and the internal address (1:1 NAT). nginx
  listens on all addresses (`0.0.0.0`), so that does not matter - just never
  put the external IP into a config file on the VM. The **metadata server**
  (`metadata.google.internal`, reachable only from inside the VM - including
  its containers) tells the VM about itself.

### e2-micro only: add a swap file

With 1 GB of RAM the kernel's OOM killer would end the deploy sooner or
later. A swap file turns "killed" into "slow". It lives on a network disk,
so it is a safety net, not extra RAM:

```bash
you@server$ sudo fallocate -l 2G /swapfile
you@server$ sudo chmod 600 /swapfile                    # swap may contain secrets from RAM
you@server$ sudo mkswap /swapfile
you@server$ sudo swapon /swapfile
you@server$ echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab    # survive reboots
you@server$ free -h
```

## 6. Create a non-root `deploy` user

You now have **two** kinds of accounts on the VM, on purpose:

| Account | Created by | Used for | sudo |
|---------|-----------|----------|------|
| your admin user | gcloud + guest agent, from your Google identity | administration | passwordless |
| `deploy` | you, by hand (this step) | owns `/opt/devops-workshop`, runs `deploy.sh`, target of the CI deploy | with a password |

The application and CI should not depend on one person's Google account:
removing a student from the project must not break deploys, and the CI key
must be revocable on its own. `deploy` is an ordinary local Linux account with
keys in its own `~/.ssh/authorized_keys` - that works with and without OS
Login.

```bash
you@server$ sudo adduser deploy                 # asks for a password - sudo will ask for it
you@server$ sudo usermod -aG sudo deploy        # members of "sudo" may use sudo (with that password)
you@server$ sudo install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
```

(Membership in the `docker` group follows in step 8, once Docker has created
that group.)

`deploy` needs **your personal** public key. Skip the `ssh-keygen` if
`ls ~/.ssh/id_ed25519.pub` already shows one:

```bash
laptop$ ssh-keygen -t ed25519 -C "your-name@laptop"
laptop$ cat ~/.ssh/id_ed25519.pub        # this PUBLIC key goes to the VM
```

Ed25519 keys are short, fast and secure. Protect the private key with a
passphrase; `ssh-agent` remembers it so you only type it once per session.
The private key (`id_ed25519`, without `.pub`) never leaves your laptop.

Paste the public key into `deploy`'s `authorized_keys` (one key per line):

```bash
you@server$ echo 'ssh-ed25519 AAAA...paste...your...key your-name@laptop' | sudo tee /home/deploy/.ssh/authorized_keys >/dev/null
you@server$ sudo chown deploy:deploy /home/deploy/.ssh/authorized_keys
you@server$ sudo chmod 600 /home/deploy/.ssh/authorized_keys       # sshd ignores files others can write to
```

**Keep the gcloud session open** and test in a **second** terminal:

```bash
laptop$ ssh deploy@203.0.113.10
deploy@server$ sudo -v && echo "sudo works"
```

The first connection asks *"Are you sure you want to continue connecting?"*:
your plain `ssh` client has never seen this VM's **host key** before.
Answering `yes` stores it in `~/.ssh/known_hosts`; from now on SSH warns
loudly if the key ever changes (which could mean a man-in-the-middle). This is
called *trust on first use* - step 14.2 shows how to verify the key properly.

Optional, but convenient - an alias in `~/.ssh/config` on your laptop:

```
Host bugsquash
    HostName 203.0.113.10
    User deploy
```

Now `ssh bugsquash` is enough.

> **Do not** run `gcloud compute ssh deploy@devops-workshop`. gcloud would
> register a key for a user named `deploy` in the project metadata, and the
> guest agent would add `deploy` to `google-sudoers` - passwordless sudo, the
> opposite of what we want for the account CI logs in to. Use plain `ssh` for
> `deploy`, and `gcloud compute ssh` (without a user name) for yourself.

## 7. SSH hardening and automatic security updates

### 7.1 Verify the SSH server configuration

Compute Engine's Debian images already ship a key-only SSH server: password
logins and root logins are disabled. Do not take that on trust - ask `sshd`
for its **effective** configuration:

```bash
deploy@server$ sudo sshd -T | grep -E '^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication|pubkeyauthentication) '
```

Expected: `passwordauthentication no`, `kbdinteractiveauthentication no`,
`pubkeyauthentication yes`, and `permitrootlogin no` (or `without-password`:
root could only log in with a key - and root has none).

To make the policy explicit and independent of how the image was built, add a
small drop-in file. Debian's `/etc/ssh/sshd_config` starts with
`Include /etc/ssh/sshd_config.d/*.conf`, and for most settings sshd uses the
**first** value it reads. A drop-in file with a low number is therefore read
first and wins - and it survives package upgrades, unlike edits to the main
file:

```bash
deploy@server$ sudo tee /etc/ssh/sshd_config.d/10-hardening.conf >/dev/null <<'EOF'
# Keys only: password guessing becomes pointless.
PasswordAuthentication no
# Log in as yourself (gcloud) or as deploy, then sudo. Root is never a direct target.
PermitRootLogin no
X11Forwarding no
EOF

deploy@server$ sudo sshd -t                 # syntax check - no output means OK
deploy@server$ sudo systemctl reload ssh    # Debian's service is called "ssh"
deploy@server$ sudo sshd -T | grep -E '^(permitrootlogin|passwordauthentication|x11forwarding) '
```

> **Do NOT add `AllowUsers deploy`** (a common hardening tip on servers with a
> single login user). Your admin account is created by gcloud and the guest
> agent - and so is the account of every teammate who runs
> `gcloud compute ssh` later. With `AllowUsers deploy`, sshd rejects all of
> them: `gcloud compute ssh` fails with *Permission denied (publickey)*.
> On Compute Engine, *who* may log in is decided by IAM and the SSH keys, not
> by a list in `sshd_config`.

Test from **new** terminals before closing the old ones:
`gcloud compute ssh devops-workshop --zone="$ZONE"` and `ssh deploy@...` must
work, `ssh root@203.0.113.10` must fail with *Permission denied*. (Locked
out anyway? See [Troubleshooting](#troubleshooting).)

> Optional: `fail2ban` bans IPs after repeated failed logins. With password
> authentication disabled it mostly reduces log noise. Debian logs to the
> systemd journal, so configure the jail with `backend = systemd`.

### 7.2 Automatic security updates

Google's Debian images come with **unattended-upgrades** installed and
enabled: Debian security updates are downloaded and installed daily. Check:

```bash
deploy@server$ apt-config dump | grep -E '^APT::Periodic::(Update-Package-Lists|Unattended-Upgrade) '
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
deploy@server$ systemctl list-timers 'apt-daily*'
```

`apt-daily.timer` downloads, `apt-daily-upgrade.timer` installs. By default
only packages from **Debian-Security** are installed automatically (see
`/etc/apt/apt.conf.d/50unattended-upgrades`) - not Docker from docker.com,
which you upgrade deliberately with `sudo apt upgrade`.

If either value is missing or `"0"`, turn it on:

```bash
deploy@server$ sudo apt install -y unattended-upgrades apt-listchanges
deploy@server$ sudo dpkg-reconfigure -plow unattended-upgrades    # answer "Yes"
```

What the image does **not** do is reboot - and kernel and libc updates only
take effect after one. Let the VM do it at night:

```bash
deploy@server$ sudo tee /etc/apt/apt.conf.d/52unattended-upgrades-local >/dev/null <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:00";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF

deploy@server$ sudo unattended-upgrade --dry-run --debug 2>&1 | tail -n 20
```

A nightly reboot is safe for our stack: the Docker daemon is enabled at boot,
and every service in `docker-compose.prod.yml` has `restart: unless-stopped`,
so the containers come back on their own. The static IP stays attached, too.

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
#    dpkg --print-architecture prints amd64 on E2 and arm64 on T2A/C4A VMs.
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
> run `docker run -v /:/host ...` and edit any file on the VM. Only add
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

This is the moment to test step 3 end to end - the firewall rule, the network
tags and a listening web server:

```bash
laptop$ curl -sI http://203.0.113.10/ | head -n 1
HTTP/1.1 200 OK
```

A timeout here means the packet never reached nginx: check the rule and the
tags (see [Troubleshooting](#troubleshooting)).

Now remove Debian's "Welcome to nginx" default site, so requests for unknown
host names are not answered with a placeholder page:

```bash
deploy@server$ sudo rm /etc/nginx/sites-enabled/default    # a symlink; the original stays in sites-available
deploy@server$ sudo nginx -t && sudo systemctl reload nginx
```

The site configuration and the TLS certificate come in
[`letsencrypt-setup.md`](./letsencrypt-setup.md) - after the app runs (step 13)
and DNS points to the VM.

## 10. Clone the repository to `/opt/devops-workshop`

`/opt` is the conventional place for self-contained add-on software. The
`deploy` user owns the directory, so `git pull` and `deploy.sh` never need sudo.

```bash
deploy@server$ sudo install -d -o deploy -g deploy /opt/devops-workshop
deploy@server$ git clone https://github.com/<your-account>/<your-repo>.git /opt/devops-workshop
deploy@server$ cd /opt/devops-workshop
```

**Private repository?** Create a read-only *deploy key* instead of storing
your personal credentials on the VM:

```bash
deploy@server$ ssh-keygen -t ed25519 -f ~/.ssh/github_deploy -N "" -C "devops-workshop deploy key"
deploy@server$ cat ~/.ssh/github_deploy.pub
# GitHub -> repository -> Settings -> Deploy keys -> Add deploy key (leave "Allow write access" OFF)
deploy@server$ GIT_SSH_COMMAND="ssh -i ~/.ssh/github_deploy" \
    git clone git@github.com:<your-account>/<your-repo>.git /opt/devops-workshop
deploy@server$ git -C /opt/devops-workshop config core.sshCommand "ssh -i ~/.ssh/github_deploy"
```

Never edit tracked files on the VM: `git pull --ff-only` (used by the
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

The template [`.env.prod.example`](../.env.prod.example) explains every
variable. Things worth knowing:

* `POSTGRES_PASSWORD` is only applied when the database volume is **created**
  (first start). Changing it later does not change the password stored inside
  the existing database - you would also have to run `ALTER USER` in `psql`.
* Changing `JWT_SECRET` logs every user out (their tokens no longer verify).
* Save a copy of `.env.prod` in your password manager. It is not in Git, so it
  is not backed up anywhere else.

## 12. Docker Hub login (optional)

* **Public images** (the default for a free Docker Hub repository): no login
  needed. Anonymous pulls are rate-limited per IP address, which is fine for
  occasional deploys - and your static IP is yours alone.
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

The script ([`deploy.sh`](./deploy.sh)) validates the configuration, pulls
the images, starts `db -> backend -> frontend` in dependency order, waits for
every healthcheck, and smoke-tests the loopback ports. Check it yourself:

```bash
deploy@server$ curl -s http://127.0.0.1:3000/api/health; echo
{"status":"ok","db":"up","version":"1a2b3c4","uptime":12}
deploy@server$ docker compose -f docker-compose.prod.yml --env-file .env.prod ps
deploy@server$ docker stats --no-stream        # memory usage vs. the cgroup limits
```

Now verify the two firewall layers from
[step 3](#why-no-ufw---and-why-dockers-ports-are-bound-to-127001):

```bash
deploy@server$ sudo ss -tlnp | grep -E ':(3000|8080)\b'     # must show 127.0.0.1, not 0.0.0.0
laptop$ curl -m 5 http://203.0.113.10:3000/api/health          # must time out: no VPC rule allows 3000
```

The app now runs - but only on `127.0.0.1`. Continue with
[`cloudflare-dns-guide.md`](./cloudflare-dns-guide.md) (if the DNS record does
not exist yet) and then [`letsencrypt-setup.md`](./letsencrypt-setup.md) to put
the host nginx with HTTPS in front of it.

## 14. Optional: automatic deploys from GitHub Actions

The `deploy` job in
[`.github/workflows/ci-main.yml`](../.github/workflows/ci-main.yml) SSHes into
the VM after every successful build on `main` and runs:

```bash
cd /opt/devops-workshop && git pull --ff-only && ./deploy/deploy.sh sha-<short-commit>
```

It deploys the **immutable** `sha-...` tag of the commit it just built, so
production always runs exactly the tested image, and a rollback is
`./deploy/deploy.sh sha-<older-commit>`.

Requirement: port 22 is reachable from the internet (the `default-allow-ssh`
rule, see [step 3](#port-22-open-to-the-internet-or-only-through-iap)) -
GitHub-hosted runners connect from changing addresses.

### 14.1 A dedicated key pair for CI

Never give CI your personal key - a dedicated key can be revoked on its own.

```bash
laptop$ ssh-keygen -t ed25519 -f ~/.ssh/bugsquash_ci -N "" -C "github-actions deploy"
laptop$ cat ~/.ssh/bugsquash_ci.pub
```

Append the public key on the VM, prefixed with `restrict`, which
disables port/agent/X11 forwarding and terminal allocation for this key.
Running a command - all CI needs - still works:

```bash
deploy@server$ echo 'restrict ssh-ed25519 AAAA...paste...the...key github-actions deploy' >> ~/.ssh/authorized_keys
```

The CI key can run anything `deploy` can - including `docker`, which is
root-equivalent - but not `sudo`, because that asks for `deploy`'s password.

### 14.2 Pin the server's host key

Without it, the workflow falls back to trust-on-first-use (and prints a
warning). Fetch the host key over the network, then compare it with a source
an attacker cannot fake:

```bash
# 1. What the network says (in theory, a man in the middle could answer instead of your VM):
laptop$ ssh-keyscan -t ed25519 203.0.113.10 > bugsquash_known_hosts
laptop$ cat bugsquash_known_hosts
203.0.113.10 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...

# 2. What the VM itself reported to Google through the metadata server
#    (possible thanks to --metadata=enable-guest-attributes=TRUE in step 4):
laptop$ gcloud compute instances get-guest-attributes devops-workshop --zone="$ZONE" --query-path="hostkeys/"
NAMESPACE  KEY                  VALUE
hostkeys   ecdsa-sha2-nistp256  AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYA...
hostkeys   ssh-ed25519          AAAAC3NzaC1lZDI1NTE5AAAA...
hostkeys   ssh-rsa              AAAAB3NzaC1yc2EAAAADAQABAAAB...
```

The `ssh-ed25519` **VALUE** must be exactly the base64 string in
`bugsquash_known_hosts`. Path 2 travels over your authenticated Google API
session, not over port 22, so a man in the middle would have to fake both.

VM created without guest attributes? Compare **fingerprints** instead, the
second one read from inside the VM:

```bash
laptop$ ssh-keygen -lf bugsquash_known_hosts
deploy@server$ ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub   # must print the SAME fingerprint
```

The pin stays valid as long as the VM exists: the static IP does not change,
and the host keys survive stop/start and reboots. A **re-created** VM has new
host keys - repeat this step and update the secret.

### 14.3 GitHub settings

Repository -> **Settings** -> **Secrets and variables** -> **Actions**:

| Kind | Name | Value |
|------|------|-------|
| Secret | `DEPLOY_HOST` | `203.0.113.10` - the **static external IP**, not the domain (a Cloudflare-proxied name does not forward SSH) |
| Secret | `DEPLOY_USER` | `deploy` |
| Secret | `DEPLOY_SSH_KEY` | full content of `~/.ssh/bugsquash_ci` (the **private** key, including the BEGIN/END lines) |
| Secret | `DEPLOY_KNOWN_HOSTS` | content of `bugsquash_known_hosts` (optional, recommended) |
| Variable | `ENABLE_AUTO_DEPLOY` | `true` |
| Variable | `DEPLOY_PATH` | optional, defaults to `/opt/devops-workshop` |

The job runs in the GitHub **environment** `production`. Under
**Settings -> Environments -> production** you can add *required reviewers*:
every deploy then waits for a manual click - a simple approval gate.

Push a commit to `main` and watch **Actions**: build -> deploy -> the
footer of <https://devops.gulfheight.com> shows the new commit hash.

## 15. Costs and cleanup

### What costs money

Compute Engine bills per second. For this setup:

| Item | Billed while... |
|------|-----------------|
| VM (vCPU + RAM of `e2-small`) | the VM is **running** - stopping it stops this charge |
| Boot disk (20 GB `pd-balanced`) | the disk **exists** - also while the VM is stopped |
| Static external IPv4 | it is **reserved** - attached to a running VM, attached to a stopped one, or not attached at all (the unattached case costs more) |
| Outbound traffic (egress) | data leaves Google's network - tiny for a course project |

For current prices in `europe-west3`, put exactly these items into the
pricing calculator: <https://cloud.google.com/products/calculator>. An
`e2-small` with its disk and IP costs a small monthly amount that the
free-trial credit covers comfortably for the length of a course. Committed-use
and sustained-use discounts exist, but are irrelevant at this size.

### Set a budget alert

**Billing** -> **Budgets & alerts** -> **Create budget**: scope = your
project, amount e.g. US$10 per month, alert thresholds at 50%, 90% and 100%.
Google e-mails the billing administrators when a threshold is crossed.

> A budget **only notifies** - it does not stop or cap spending. A forgotten
> VM keeps running (and billing) until you delete it.

### Pausing between lessons

```bash
laptop$ gcloud compute instances stop devops-workshop --zone="$ZONE"     # CPU/RAM billing stops
laptop$ gcloud compute instances start devops-workshop --zone="$ZONE"    # same static IP, containers come back
```

Thanks to the static IP, DNS, the pinned host key and the `DEPLOY_HOST`
secret all stay valid across stop/start.

### Delete everything after the course

Order matters: delete the VM first, so the static IP is no longer in use.

```bash
laptop$ gcloud compute instances delete devops-workshop --zone="$ZONE"    # also deletes the boot disk (auto-delete)
laptop$ gcloud compute firewall-rules delete allow-http-https
laptop$ gcloud compute addresses delete devops-workshop-ip --region="$REGION"
laptop$ gcloud compute snapshots list                                     # delete any snapshots you made, too

# Check that nothing billable is left:
laptop$ gcloud compute instances list
laptop$ gcloud compute disks list
laptop$ gcloud compute addresses list
```

Or remove **everything at once** - all resources, the APIs, the billing link:

```bash
laptop$ gcloud projects delete "$PROJECT_ID"     # recoverable for 30 days, then gone
```

Outside Google Cloud, also clean up:

* Cloudflare: delete the `devops` A record - it would point at an IP address
  Google can hand to someone else.
* GitHub: set `ENABLE_AUTO_DEPLOY` to `false` (or delete the variable) and
  delete the `DEPLOY_*` secrets.
* Your laptop: delete `~/.ssh/bugsquash_ci*` and `bugsquash_known_hosts`.

> **Console:** **Compute Engine** -> **VM instances** -> select -> **Delete**;
> **VPC network** -> **Firewall** -> `allow-http-https` -> **Delete**;
> **VPC network** -> **IP addresses** -> `devops-workshop-ip` -> **Release
> static address**; or **IAM & Admin** -> **Settings** -> **Shut down** the
> whole project.

---

## Day-2 operations cheat sheet

On the VM:

```bash
cd /opt/devops-workshop
alias dc='docker compose -f docker-compose.prod.yml --env-file .env.prod'

dc ps                                   # state + health of each container
dc logs -f --tail=100 backend           # follow the backend logs
docker stats                            # live CPU / memory per container (cgroups!)
./deploy/deploy.sh sha-1a2b3c4          # deploy or roll back to an exact build
dc restart backend                      # SIGTERM -> graceful shutdown -> start again
dc exec db psql -U bugsquash bugsquash  # SQL shell inside the db container
dc exec -T db pg_dump -U bugsquash bugsquash | gzip > ~/backup-"$(date +%F)".sql.gz
docker system df                        # disk used by images, containers, volumes
df -h /                                 # free space on the boot disk
sudo tail -f /var/log/nginx/devops.gulfheight.com.access.log
sudo journalctl -u google-guest-agent --since -1h   # SSH keys / users created by gcloud
```

On your laptop (with the shell variables from the top of this guide):

```bash
gcloud compute instances list                                   # status + external IP
gcloud compute ssh devops-workshop --zone="$ZONE"               # admin login
gcloud compute instances stop devops-workshop --zone="$ZONE"    # pause (disk + IP still billed)
gcloud compute instances start devops-workshop --zone="$ZONE"
gcloud compute instances get-serial-port-output devops-workshop --zone="$ZONE"   # boot log, even when SSH is broken
gcloud compute disks snapshot devops-workshop --zone="$ZONE" --snapshot-names="devops-workshop-$(date +%F)"
gcloud compute firewall-rules list
```

A **disk snapshot** is a point-in-time copy of the whole boot disk - OS,
Docker images and the Postgres volume. Take one before risky changes (it is
billed per GB stored). For the database alone, the `pg_dump` above is smaller
and portable.

## Troubleshooting

| Symptom | Likely cause | Check / fix |
|---------|--------------|-------------|
| `Compute Engine API has not been used in project ...` | API not enabled | `gcloud services enable compute.googleapis.com` |
| `... billing ...` error on create | no billing account linked | `gcloud billing projects link` (step 1.3) |
| `The resource '.../networks/default' was not found` | the project has no `default` network (some organisations disable it) | `gcloud compute networks create default --subnet-mode=auto`, then allow SSH: `gcloud compute firewall-rules create default-allow-ssh --network=default --allow=tcp:22 --source-ranges=0.0.0.0/0` |
| `ZONE_RESOURCE_POOL_EXHAUSTED` or a quota error on create | the zone is temporarily out of that machine type | try another zone of the **same region** (`europe-west3-b`, `-c`): the static IP is regional and still fits |
| `gcloud compute ssh` hangs / times out | no rule allows port 22 (deleted `default-allow-ssh`?), or the VM is not running | `gcloud compute firewall-rules list`, `gcloud compute instances list`; boot log via `get-serial-port-output` |
| `curl http://<IP>/` times out, but SSH works | VM lacks the network tags, or the rule is missing | `gcloud compute instances describe devops-workshop --zone="$ZONE" --format="value(tags.items)"`; add them with `gcloud compute instances add-tags devops-workshop --zone="$ZONE" --tags=http-server,https-server` |
| `curl http://<IP>/` is refused | packet arrived, but nothing listens on port 80 | `systemctl status nginx`, `sudo ss -tlnp \| grep ':80\b'` |
| `ssh deploy@...`: *Permission denied (publickey)* | key missing or wrong permissions on `~/.ssh` | `sudo ls -la /home/deploy/.ssh` (700 / 600, owner `deploy`); `sudo journalctl -u ssh -n 50` names the reason |
| `gcloud compute ssh` itself: *Permission denied* after step 7 | an `AllowUsers` line, or a broken drop-in | fix via a startup script, see below |
| Containers restart / `dmesg` shows `Out of memory` | too little RAM (e2-micro without swap) | `sudo journalctl -k \| grep -i oom`; add swap (step 5) or move to `e2-small` (step 4) |
| CI: `Host key verification failed` | VM was re-created (new host keys) or `DEPLOY_HOST` changed | repeat step 14.2, update `DEPLOY_KNOWN_HOSTS` |
| CI: `Connection timed out` on port 22 | SSH only allowed from IAP | CI needs `default-allow-ssh` (or an equivalent rule) |
| Let's Encrypt fails although IPv4 works | a leftover AAAA record | the VM has no IPv6: delete the AAAA record ([`cloudflare-dns-guide.md`](./cloudflare-dns-guide.md)) |
| The external IP changed after a stop/start, or `devops-workshop-ip` shows `RESERVED` instead of `IN_USE` | the VM was created without `--address` and got an ephemeral IP | swap in the static IP, see below |

**Attach the static IP to an existing VM.** An external IP is attached
through the network interface's *access config*. Replace it (the VM is
briefly unreachable):

```bash
laptop$ gcloud compute instances describe devops-workshop --zone="$ZONE" \
    --format="value(networkInterfaces[0].accessConfigs[0].name)"     # usually "external-nat"
laptop$ gcloud compute instances delete-access-config devops-workshop --zone="$ZONE" \
    --access-config-name="external-nat"
laptop$ gcloud compute instances add-access-config devops-workshop --zone="$ZONE" \
    --access-config-name="external-nat" --address=203.0.113.10       # the IP itself, not its name
```

Then check that DNS and the `DEPLOY_HOST` secret use that IP.

**Locked out of SSH** (for example by an `AllowUsers` line): Compute Engine
runs a **startup script** from the metadata as root on every boot, without
SSH. Use it to remove the faulty file, reboot, then delete the script again:

```bash
laptop$ gcloud compute instances add-metadata devops-workshop --zone="$ZONE" \
    --metadata=startup-script='rm -f /etc/ssh/sshd_config.d/10-hardening.conf; systemctl reload ssh'
laptop$ gcloud compute instances reset devops-workshop --zone="$ZONE"     # hard reboot
laptop$ gcloud compute ssh devops-workshop --zone="$ZONE"
laptop$ gcloud compute instances remove-metadata devops-workshop --zone="$ZONE" --keys=startup-script
```

Then recreate the drop-in from step 7.1 - without the line that locked you out.
