# ansible/: the code behind Stage 5

The step-by-step guide is **[Stage 5: The VM as code](../stages/stage-5-ansible.md)**. This page only
maps the files.

| File | What it is |
|---|---|
| `provision.sh` | the one command you run: `./ansible/provision.sh [--new-vm] [user@host] [playbook.yml]` |
| `site.yml` | the full server: `docker.yml` + `app.yml` |
| `docker.yml` | Docker Engine, base packages and the `deploy` user (no secrets needed) |
| `app.yml` | the app: deploy bundle, `.env.prod`, stack, TLS certificate, renewal timer, restores |
| `backup.yml` | pulls an encrypted database dump and certificate archive to `backups/<domain>/` |
| `bootstrap-secrets.sh` | one-time: creates `secrets/vault.yml` and `.vault_pass` |
| `group_vars/all.yml` | settings you could print on a slide (domain, Docker Hub user, image tag, ...) |
| `secrets/vault.example.yml` | the keys the encrypted `secrets/vault.yml` must contain |
| `inventory.example.ini` | template for `inventory.ini` (your server's address and user) |
| `roles/` | `common`, `docker`, `deploy_user`, `app`, `tls`, `backup`, `cloudflare_dns`, `github_ci` |

Never committed (see `.gitignore`): `inventory.ini`, `.vault_pass`, `backups/`.
