# Google Cloud reference

[README](../README.md) · [Stage 1](stage-1-ip-http.md) · [Stage 2](stage-2-domain-http.md) · [Stage 3](stage-3-https.md) · [Stage 4](stage-4-automated-deploys.md) · [Stage 5](../ansible/README.md) · **Google Cloud reference**

This page is a lookup, not a story. The stages tell you what to do; come here to understand the
Google Cloud parts, compare options, or clean up. Commands run on your laptop (or in Cloud Shell)
with the [gcloud CLI](https://cloud.google.com/sdk/docs/install); `<VM-IP>` is your static external IP.

| The course VM | Value | Set in |
|---------------|-------|--------|
| Name, zone | `devops`, `europe-central2-a` (Warsaw) | [Stage 1, step 1](stage-1-ip-http.md#1-create-the-vm) |
| Machine | `e2-medium` (2 shared vCPUs, 4 GB), Debian 13, balanced disk | Stage 1, step 1 |
| External IP | static, named `devops-ip` | [Stage 1, step 2](stage-1-ip-http.md#2-make-the-ip-address-static) |
| Firewall | network tags `http-server`, `https-server` | Stage 1, step 1 (the two *Allow* boxes) |

```text
 internet --> [ VPC firewall: tcp 22, 80, 443 ] --> VM "devops" --> proxy container :80 / :443
               runs in Google's network,             only Docker is installed on the VM
               outside the VM
```

## 1. Machine types

| Type | vCPUs | RAM | Verdict |
|------|-------|-----|---------|
| `e2-micro` | 2 shared (0.25 sustained) | 1 GB | Always Free, but only in `us-west1`, `us-central1`, `us-east1`; too tight without swap |
| `e2-small` | 2 shared (0.5 sustained) | 2 GB | Enough: the VM only pulls and runs images, CI builds them |
| `e2-medium` | 2 shared (1 sustained) | 4 GB | **The course VM.** Room for experiments and monitoring later |
| `t2a-standard-1`, `c4a-standard-1` | 1 (Arm) | 4 GB | Also works: CI pushes `linux/arm64` images too. Image family `debian-13-arm64`, only in some zones |

Shared-core E2 machines get a slice of two vCPUs and may burst to 100% for short periods, which suits a
mostly idle web app. The memory limits in `docker-compose.prod.yml` add up to 896 MB (db 512M,
backend 256M, frontend 64M, proxy 64M), plus 256M while certbot runs, before the OS and Docker itself.
To change the type later, stop the VM, run `gcloud compute instances set-machine-type devops
--zone=europe-central2-a --machine-type=e2-small` and start it again; the static IP stays.

## 2. Static external IP

A VM has an **internal** IP (`10.x.x.x`, useless in DNS) and an **external** one for the internet. By
default the external IP is *ephemeral*: Google takes it back when the VM stops. A *static* IP stays
reserved in your project until you release it, so the DNS record (Stage 2), the `DEPLOY_HOST` secret
(Stage 4) and the Ansible inventory (Stage 5) never need to change, even when you rebuild the VM.

```console
laptop$ gcloud compute addresses create devops-ip --region=europe-central2 --addresses=<VM-IP>   # promote the current IP
laptop$ gcloud compute addresses create devops-ip --region=europe-central2                       # or reserve a new one
laptop$ gcloud compute addresses list        # IN_USE = attached to a VM, RESERVED = idle (still billed)
```

To create a VM with a reserved address, add `--address=devops-ip` to the `instances create` command
in Stage 1's *Going deeper*. Static IPs are **regional**: the VM must be in the same region (any zone).
They are IPv4 only, because the `default` network has no IPv6: never add an `AAAA` record.

## 3. Firewall rules and network tags

The VPC firewall runs in Google's network, outside the VM, so nothing inside the VM (not Docker, not
a root shell) can open a hole in it. Every network blocks all incoming traffic by default; the
`default` network then allows a few things:

| Rule | Allows | Applies to |
|------|--------|------------|
| `default-allow-ssh` | tcp:22 from anywhere | every VM |
| `default-allow-icmp` | `ping` | every VM |
| `default-allow-internal` | everything between VMs of this network | every VM |
| `default-allow-rdp` | tcp:3389 (Windows), unused here | every VM; delete it if you like |
| `default-allow-http`, `default-allow-https` | tcp:80, tcp:443 from anywhere | only VMs tagged `http-server`, `https-server` |

The console's *Allow HTTP/HTTPS traffic* boxes create the last two rules and put the two **network
tags** on the VM. A tag works like a festival wristband: a rule with target tags only lets in VMs
that wear the matching band.

```console
laptop$ gcloud compute firewall-rules list
laptop$ gcloud compute instances describe devops --zone=europe-central2-a --format='value(tags.items)'
laptop$ gcloud compute instances add-tags devops --zone=europe-central2-a --tags=http-server,https-server
```

There is no `ufw` on the VM on purpose. Ports published by Docker skip a host firewall anyway (Stage
1, *Going deeper: why only the proxy publishes ports*), so the VPC firewall is the real gate, and only
the proxy container publishes anything: ports 80 and 443.

## 4. SSH access

- **SSH keys in the VM's metadata** (Stage 1): the key's last word becomes the user name, and Google's
  guest agent gives that account passwordless `sudo` (group `google-sudoers`). That is why Stage 4
  never adds the `deploy` user's key this way.
- **`gcloud compute ssh devops --zone=europe-central2-a`** creates and uploads its own key
  (`~/.ssh/google_compute_engine`); `gcloud compute scp` copies files with it. If your organisation
  enforces OS Login, plain `ssh` with a metadata key is refused: use these two commands instead.
- **Verify a host key.** Stage 4 compares fingerprints inside a session you already trust. A VM
  created with `--metadata=enable-guest-attributes=TRUE` also publishes its host keys through
  Google's API: `gcloud compute instances get-guest-attributes devops --zone=europe-central2-a
  --query-path=hostkeys/`; its `ssh-ed25519` value must equal what `ssh-keyscan` printed.
- **No service account needed.** The app calls no Google API. A VM created with *Service account:
  None* (`--no-service-account --no-scopes`) holds no Google credentials that a hijacked container
  could fetch from the metadata server.

<details>
<summary>Going deeper: close port 22 to the internet with IAP</summary>

If you deploy only by hand, Google's Identity-Aware Proxy can carry your SSH sessions: it checks your
Google login first and connects from a fixed Google range, so port 22 no longer faces the internet.

```console
laptop$ gcloud compute firewall-rules create allow-ssh-from-iap --network=default --allow=tcp:22 --source-ranges=35.235.240.0/20
laptop$ gcloud compute firewall-rules delete default-allow-ssh
laptop$ gcloud compute ssh devops --zone=europe-central2-a --tunnel-through-iap
```

The price: GitHub-hosted runners connect from ever-changing addresses, so the CI deploy job (Stage 4)
stops working, and so do plain `ssh`, `scp` and Ansible from your laptop. Accounts other than the
project owner need the IAM role *IAP-secured Tunnel User*.

</details>

## 5. Costs and cleanup

| Item | Billed while |
|------|--------------|
| VM (vCPUs + RAM) | it runs; stopping it stops this charge |
| Boot disk | it exists, also while the VM is stopped |
| Static IP | it is reserved, at a higher rate while not attached to a running VM |
| Outbound traffic | data leaves Google's network; tiny for this course |

Put these items into the [pricing calculator](https://cloud.google.com/products/calculator); the
free-trial credit for new accounts covers a course comfortably. A budget alert (**Billing -> Budgets &
alerts**, for example US$10 with alerts at 50, 90 and 100%) only sends e-mails: it never stops a VM.

```console
laptop$ gcloud compute instances stop devops --zone=europe-central2-a      # pause: disk and IP still billed
laptop$ gcloud compute instances start devops --zone=europe-central2-a     # same IP; Docker restarts the stack
```

After the course, delete the VM first, then the address it used:

```console
laptop$ ./ansible/provision.sh backup.yml       # optional (Stage 5): keep the database and the certificate
laptop$ gcloud compute instances delete devops --zone=europe-central2-a    # deletes its boot disk too
laptop$ gcloud compute addresses delete devops-ip --region=europe-central2
laptop$ gcloud compute instances list && gcloud compute disks list && gcloud compute addresses list
```

Or delete the whole project: `gcloud projects delete <project-id>`. Outside Google Cloud, delete the
Cloudflare A record (Google may hand that IP to someone else), set `ENABLE_AUTO_DEPLOY` to `false` and
delete the `DEPLOY_*` secrets on GitHub, and remove `~/.ssh/bugsquash_ci*` from your laptop.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Compute Engine API has not been used in project ...` | `gcloud services enable compute.googleapis.com`, or open *Compute Engine* once in the console. |
| `ZONE_RESOURCE_POOL_EXHAUSTED` when creating the VM | The zone is out of that type for now: pick another zone of the same region (`europe-central2-b`, `-c`). |
| `The resource '.../networks/default' was not found` | The project has no default network: `gcloud compute networks create default --subnet-mode=auto`, then recreate the SSH, HTTP and HTTPS rules. |
| `ssh` times out | The VM is stopped or no rule allows tcp:22: `gcloud compute instances list`, `gcloud compute firewall-rules list`. Boot log without SSH: `gcloud compute instances get-serial-port-output devops --zone=europe-central2-a`. |
| `curl http://<VM-IP>` times out, but SSH works | Tags or rules are missing: section 3. |
| The external IP changed after a stop/start | It was ephemeral: promote the new one (section 2), then update the A record and `DEPLOY_HOST`. |
