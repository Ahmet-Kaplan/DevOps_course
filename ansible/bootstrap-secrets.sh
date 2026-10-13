#!/usr/bin/env bash
# =============================================================================
# ansible/bootstrap-secrets.sh - create the encrypted secrets file, ONCE
# -----------------------------------------------------------------------------
# Usage (on your LAPTOP, from anywhere in the repository):
#
#   ./ansible/bootstrap-secrets.sh                          # brand-new secrets
#   ./ansible/bootstrap-secrets.sh --from-env .env.prod     # adopt a server you set up by hand
#   ./ansible/bootstrap-secrets.sh --force ...              # replace an existing vault
#
# It creates two files:
#
#   ansible/.vault_pass         the vault PASSWORD (random, chmod 600, git-ignored).
#                               Whoever has it can decrypt everything below.
#   ansible/secrets/vault.yml   the SECRETS, encrypted with that password:
#                               POSTGRES_PASSWORD, JWT_SECRET, an SSH key pair
#                               for the CI deploy job, optional API tokens.
#
# Why --from-env? If you already run the app (stages 1-4), its database volume
# was created with the POSTGRES_PASSWORD from your .env.prod. PostgreSQL reads
# that variable only when the volume is FIRST created. If Ansible rendered a
# NEW password, the backend could no longer log in to its own database. So
# --from-env copies POSTGRES_PASSWORD and JWT_SECRET from that file instead of
# generating new ones (keeping JWT_SECRET also keeps everybody logged in).
#
# Options:
#   --from-env FILE       import POSTGRES_PASSWORD and JWT_SECRET from FILE
#   --force               overwrite an existing secrets/vault.yml
#   --vault-file FILE     where to write the vault   (default: ansible/secrets/vault.yml)
#   --password-file FILE  the vault password file    (default: ansible/.vault_pass,
#                         or $ANSIBLE_VAULT_PASSWORD_FILE if that is set)
# Optional tokens, read from the environment if set (else left empty):
#   CLOUDFLARE_API_TOKEN=...  DOCKER_HUB_TOKEN=...  ./ansible/bootstrap-secrets.sh
# (or add them later with: ansible-vault edit secrets/vault.yml)
# =============================================================================

set -euo pipefail

# ---- Pretty output (same helpers as provision.sh) --------------------------------
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_RESET=$'\033[0m' C_BOLD=$'\033[1m' C_DIM=$'\033[2m'
  C_RED=$'\033[31m' C_GREEN=$'\033[32m' C_YELLOW=$'\033[33m' C_BLUE=$'\033[34m'
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
Usage: ./ansible/bootstrap-secrets.sh [--from-env FILE] [--force]
                                      [--vault-file FILE] [--password-file FILE]

  --from-env FILE       take POSTGRES_PASSWORD and JWT_SECRET from an existing
                        .env.prod (a server you deployed by hand) - REQUIRED if
                        that server's database must keep working
  --force               overwrite an existing vault file
  --vault-file FILE     default: ansible/secrets/vault.yml
  --password-file FILE  default: ansible/.vault_pass ($ANSIBLE_VAULT_PASSWORD_FILE wins)

Environment (optional): CLOUDFLARE_API_TOKEN, DOCKER_HUB_TOKEN
EOF
}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIR

# ---- Arguments -------------------------------------------------------------------
from_env=""
force=0
vault_file="${SCRIPT_DIR}/secrets/vault.yml"
pass_file="${ANSIBLE_VAULT_PASSWORD_FILE:-${SCRIPT_DIR}/.vault_pass}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h | --help) usage; exit 0 ;;
    --force) force=1 ;;
    --from-env | --vault-file | --password-file)
      [[ $# -ge 2 && -n "$2" ]] || { usage >&2; die "$1 needs a file name."; }
      case "$1" in
        --from-env) from_env=$2 ;;
        --vault-file) vault_file=$2 ;;
        --password-file) pass_file=$2 ;;
      esac
      shift
      ;;
    *) usage >&2; die "Unknown argument '$1'." ;;
  esac
  shift
done

# ---- Tools -------------------------------------------------------------------------
# `pipx install ansible-core` puts ansible-vault into ~/.local/bin, which is
# not on every PATH right after installing.
find_tool() {
  if command -v "$1" >/dev/null 2>&1; then
    command -v "$1"
  elif [[ -x "${HOME}/.local/bin/$1" ]]; then
    printf '%s\n' "${HOME}/.local/bin/$1"
  else
    return 1
  fi
}
ANSIBLE_VAULT="$(find_tool ansible-vault)" \
  || die "ansible-vault not found. Install Ansible with: pipx install ansible-core (see stages/stage-5-ansible.md)"
command -v openssl >/dev/null 2>&1 || die "openssl not found."
command -v ssh-keygen >/dev/null 2>&1 || die "ssh-keygen not found (OpenSSH client)."

# ---- Never destroy a vault by accident -------------------------------------------
if [[ -e "$vault_file" && "$force" != "1" ]]; then
  die "$vault_file already exists. Nothing was changed.
       View it:    ansible-vault view $vault_file --vault-password-file $pass_file
       Edit it:    ansible-vault edit $vault_file --vault-password-file $pass_file
       Start over: add --force (new secrets break the database of a running server -
                   combine it with --from-env <its .env.prod>)"
fi

# Every file we create from here on: owner-only (600 / 700).
umask 077

# A private scratch directory for the PLAINTEXT secrets; removed on any exit.
work_dir="$(mktemp -d)"
cleanup() { rm -rf -- "$work_dir"; }
trap cleanup EXIT

# ---- 1. Secrets for .env.prod -----------------------------------------------------
title "1/4 Application secrets"

# Characters we accept in an imported secret. They are safe unquoted in an env
# file, in YAML and in a postgres:// URL (openssl rand -hex / -base64 output).
readonly SAFE_SECRET='^[A-Za-z0-9._~+/=-]+$'

# env_get KEY FILE: the value of KEY in a .env file, roughly like Compose reads
# it: last assignment wins, optional "export ", surrounding quotes removed,
# " # comment" after an unquoted value removed.
env_get() {
  local key=$1 file=$2 line value
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$file" | tail -n 1 || true)"
  [[ -n "$line" ]] || return 0
  value="${line#*=}"
  value="${value%$'\r'}"   # file saved on Windows (CRLF)
  if [[ "$value" =~ ^\"(.*)\"[[:space:]]*$ || "$value" =~ ^\'(.*)\'[[:space:]]*$ ]]; then
    value="${BASH_REMATCH[1]}"
  else
    value="$(sed -E 's/[[:space:]]+#.*$//; s/[[:space:]]+$//' <<<"$value")"
  fi
  printf '%s' "$value"
}

# group_var KEY: a top-level "key: value" from group_vars/all.yml (quotes removed).
group_var() {
  sed -nE "s/^$1:[[:space:]]*['\"]?([^'\"#]*[^'\"#[:space:]])['\"]?.*$/\1/p" \
    "${SCRIPT_DIR}/group_vars/all.yml" | tail -n 1
}

if [[ -n "$from_env" ]]; then
  [[ -f "$from_env" ]] || die "--from-env: file '$from_env' not found."
  postgres_password="$(env_get POSTGRES_PASSWORD "$from_env")"
  jwt_secret="$(env_get JWT_SECRET "$from_env")"
  [[ -n "$postgres_password" ]] || die "POSTGRES_PASSWORD is empty or missing in $from_env."
  [[ -n "$jwt_secret" ]] || die "JWT_SECRET is empty or missing in $from_env."
  [[ "$postgres_password" =~ $SAFE_SECRET && "$jwt_secret" =~ $SAFE_SECRET ]] \
    || die "POSTGRES_PASSWORD or JWT_SECRET in $from_env contains characters that would need quoting (space, \$, #, quotes...). Use 'openssl rand -hex 32' values, or start without --from-env."
  ok "POSTGRES_PASSWORD and JWT_SECRET imported from $from_env"

  # The other settings of that file live in group_vars/all.yml (they are not
  # secret). A different POSTGRES_USER/POSTGRES_DB would break the database
  # login just like a different password - so compare them now.
  mismatch=0
  for pair in DOMAIN:domain DOCKER_HUB_USERNAME:docker_hub_username \
              POSTGRES_DB:postgres_db POSTGRES_USER:postgres_user; do
    env_key="${pair%%:*}" yaml_key="${pair#*:}"
    env_val="$(env_get "$env_key" "$from_env")"
    yaml_val="$(group_var "$yaml_key")"
    if [[ -n "$env_val" && "$env_val" != "$yaml_val" ]]; then
      warn "$from_env has ${env_key}=${env_val}, but group_vars/all.yml has ${yaml_key}: ${yaml_val:-<empty>}"
      mismatch=1
    fi
  done
  if [[ "$mismatch" == "1" ]]; then
    warn "Edit ansible/group_vars/all.yml so the values match, BEFORE running provision.sh."
  else
    ok "DOMAIN / DOCKER_HUB_USERNAME / POSTGRES_DB / POSTGRES_USER match group_vars/all.yml"
  fi
else
  # 32 random bytes as 64 hex characters = 256 bits, the same as stage 1.
  postgres_password="$(openssl rand -hex 32)"
  jwt_secret="$(openssl rand -hex 32)"
  ok "Generated a new POSTGRES_PASSWORD and JWT_SECRET (openssl rand -hex 32)"
fi

# ---- 2. SSH key pair for the CI deploy job ------------------------------------------
title "2/4 SSH key pair for the GitHub Actions deploy job"
# ed25519: short keys, fast, the modern default. -N '' = no passphrase (a
# robot cannot type one); the key is protected by the vault instead.
ssh-keygen -q -t ed25519 -N '' -C "bugsquash-ci-deploy" -f "${work_dir}/ci_deploy_key"
ci_private_key="$(cat "${work_dir}/ci_deploy_key")"
ci_public_key="$(cat "${work_dir}/ci_deploy_key.pub")"
ok "New key pair: ${ci_public_key:0:40}..."

# ---- Optional tokens ------------------------------------------------------------------
cloudflare_token="${CLOUDFLARE_API_TOKEN:-}"
docker_hub_token="${DOCKER_HUB_TOKEN:-}"
for name in cloudflare_token docker_hub_token; do
  [[ "${!name}" =~ ^[A-Za-z0-9._-]*$ ]] || die "${name} contains unexpected characters."
done
[[ -z "$cloudflare_token" ]] || ok "Cloudflare API token taken from \$CLOUDFLARE_API_TOKEN"
[[ -z "$docker_hub_token" ]] || ok "Docker Hub token taken from \$DOCKER_HUB_TOKEN"

# ---- 3. The vault password -------------------------------------------------------------
title "3/4 Vault password"
if [[ -s "$pass_file" ]]; then
  # Never replace an existing password: the encrypted BACKUPS in
  # ansible/backups/ use it too, and would become unreadable.
  ok "Using the existing password file $pass_file"
else
  mkdir -p -- "$(dirname -- "$pass_file")"
  openssl rand -hex 32 >"$pass_file"
  chmod 600 "$pass_file"
  ok "Created $pass_file (random, mode 600)"
fi

# ---- 4. Write and encrypt the vault -----------------------------------------------------
title "4/4 Encrypting the secrets"
plain="${work_dir}/vault.yml"
{
  echo "---"
  echo "# Encrypted with ansible-vault. Created by ansible/bootstrap-secrets.sh on $(date -u +%Y-%m-%d)."
  echo "# Keys explained in secrets/vault.example.yml."
  echo "vault_postgres_password: \"${postgres_password}\""
  echo "vault_jwt_secret: \"${jwt_secret}\""
  # "|" = YAML block scalar: the multi-line private key, kept line by line.
  echo "vault_ci_deploy_private_key: |"
  while IFS= read -r key_line; do
    printf '  %s\n' "$key_line"
  done <<<"$ci_private_key"
  echo "vault_ci_deploy_public_key: \"${ci_public_key}\""
  echo "vault_cloudflare_api_token: \"${cloudflare_token}\""
  echo "vault_docker_hub_token: \"${docker_hub_token}\""
} >"$plain"

mkdir -p -- "$(dirname -- "$vault_file")"
rm -f -- "$vault_file"   # only reached with --force (or when it did not exist)
# --encrypt-vault-id default: if ANSIBLE_VAULT_PASSWORD_FILE is exported too,
# ansible-vault sees two passwords and refuses to pick one for encrypting.
# With it, the --vault-password-file below wins.
"$ANSIBLE_VAULT" encrypt --encrypt-vault-id default --vault-password-file "$pass_file" \
  --output "$vault_file" "$plain" >/dev/null
chmod 600 "$vault_file"
# Prove the round trip works before telling anyone to rely on it.
"$ANSIBLE_VAULT" view --vault-password-file "$pass_file" "$vault_file" | grep -q '^vault_jwt_secret:' \
  || die "Could not decrypt $vault_file again - something is wrong with $pass_file."
ok "Wrote $vault_file ($(head -n 1 "$vault_file"))"

cat <<EOF

${C_BOLD}${C_GREEN}Done.${C_RESET} Next steps:

  1. Save the vault password in your password manager - without it the vault
     and every backup are lost for good:
         cat $pass_file
  2. The vault is encrypted: safe to commit (in a private repository).
     The password file is git-ignored - never commit it:
         git add ansible/secrets/vault.yml
  3. Build or update the server:
         ./ansible/provision.sh            # site.yml on the hosts in inventory.ini

${C_DIM}Look inside:  ansible-vault view $vault_file --vault-password-file $pass_file${C_RESET}
EOF
