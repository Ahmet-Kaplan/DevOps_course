#!/usr/bin/env bash
# =============================================================================
# ansible/provision.sh - run a playbook against the server, the same way every time
# -----------------------------------------------------------------------------
# Usage (on your LAPTOP, from anywhere in the repository):
#
#   ./ansible/provision.sh [--new-vm] [user@host[:port]] [playbook.yml] [ansible-playbook options...]
#
#   ./ansible/provision.sh                             # site.yml on the hosts in inventory.ini
#   ./ansible/provision.sh --new-vm you@203.0.113.10   # REBUILD: VM was recreated -> everything, one command
#   ./ansible/provision.sh you@203.0.113.10 docker.yml # one playbook, no inventory file needed
#   ./ansible/provision.sh docker.yml --check --diff   # dry run: show what WOULD change
#   ./ansible/provision.sh backup.yml                  # e.g. before deleting the VM
#   ./ansible/provision.sh -e image_tag=sha-1a2b3c4    # options after the first "-" go to ansible-playbook
#
# What it adds on top of a plain `ansible-playbook` call:
#   * runs from ansible/, so ansible.cfg, group_vars/ and roles/ are always found;
#   * user@host[:port] builds an inline inventory - no inventory.ini needed;
#   * --new-vm forgets the server's OLD SSH host key in ~/.ssh/known_hosts.
#     A recreated VM has a brand-new host key; without this, ssh refuses to
#     connect ("REMOTE HOST IDENTIFICATION HAS CHANGED!") - correctly, because
#     a changed key can also mean a man-in-the-middle. The new key is then
#     accepted on first contact (StrictHostKeyChecking=accept-new, ansible.cfg);
#   * points Ansible at the vault password file .vault_pass (when it exists),
#     so the encrypted secrets/vault.yml can be read without typing a password.
#     It does that with the environment variable ANSIBLE_VAULT_PASSWORD_FILE,
#     which the `ansible-vault` commands inside backup.yml read as well. Set it
#     yourself to use a different file (it wins over .vault_pass).
# =============================================================================

# -e: stop on the first error   -u: unset variable = error
# -o pipefail: a pipeline fails if ANY command in it fails
set -euo pipefail

# ---- Pretty output (same conventions as deploy/deploy.sh) ------------------------
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_RESET=$'\033[0m' C_BOLD=$'\033[1m' C_DIM=$'\033[2m'
  C_RED=$'\033[31m' C_GREEN=$'\033[32m' C_YELLOW=$'\033[33m' C_BLUE=$'\033[34m'
else
  C_RESET='' C_BOLD='' C_DIM='' C_RED='' C_GREEN='' C_YELLOW='' C_BLUE=''
fi
info() { printf '  %s->%s %s\n' "$C_DIM" "$C_RESET" "$*"; }
ok()   { printf '  %s[ok]%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '  %s[warn] %s%s\n' "$C_YELLOW" "$*" "$C_RESET" >&2; }
die()  { printf '\n  %s[fail] %s%s\n' "${C_BOLD}${C_RED}" "$*" "$C_RESET" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: ./ansible/provision.sh [--new-vm] [user@host[:port]] [playbook.yml] [ansible-playbook options...]

  --new-vm          the VM was (re)created: forget its old SSH host key first
  user@host[:port]  target server (admin user with sudo). Default: inventory.ini
  playbook.yml      default: site.yml (the full rebuild). Others: docker.yml,
                    app.yml, backup.yml
  options...        everything from the first option on is passed to
                    ansible-playbook, e.g. --check --diff, --tags docker,
                    -e name=value, -v

Examples:
  ./ansible/provision.sh --new-vm you@203.0.113.10
  ./ansible/provision.sh docker.yml --check --diff
EOF
}

# The directory this script lives in = the Ansible project directory.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIR

# ---- Arguments -----------------------------------------------------------------
# Leading arguments are recognised by their SHAPE: "--new-vm", something with
# an "@" (the target) and something ending in .yml/.yaml (the playbook), in any
# order. The first other option (starting with "-") ends our part; it and
# everything after it belongs to ansible-playbook.
new_vm=0
target=""
playbook=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h | --help) usage; exit 0 ;;
    --new-vm) new_vm=1 ;;
    -*) break ;;
    *.yml | *.yaml)
      [[ -z "$playbook" ]] || die "Two playbooks given ('$playbook' and '$1'). Run them one after the other, or use site.yml."
      playbook=$1
      ;;
    *@*)
      [[ -z "$target" ]] || die "Two targets given ('$target' and '$1')."
      target=$1
      ;;
    *)
      usage >&2
      die "Unexpected argument '$1' (expected user@host[:port], a playbook *.yml, or an ansible-playbook option)."
      ;;
  esac
  shift
done
# What is left ("$@") goes to ansible-playbook unchanged.

# ---- Playbook ------------------------------------------------------------------
# Accept "docker.yml" (looked up in ansible/) as well as a path relative to
# where you are, e.g. "ansible/docker.yml" from the repository root.
playbook="${playbook:-site.yml}"
if [[ -f "$playbook" ]]; then
  playbook="$(cd -- "$(dirname -- "$playbook")" && pwd -P)/$(basename -- "$playbook")"
elif [[ -f "${SCRIPT_DIR}/${playbook}" ]]; then
  playbook="${SCRIPT_DIR}/${playbook}"
else
  available="$(cd -- "$SCRIPT_DIR" && printf '%s ' *.yml)"
  die "Playbook '$playbook' not found in $SCRIPT_DIR. Available: ${available:-none}"
fi

# ---- Tools ----------------------------------------------------------------------
# `pipx install ansible-core` puts the commands into ~/.local/bin, which is not
# on every PATH (e.g. right after installing, before a new login).
find_tool() {
  if command -v "$1" >/dev/null 2>&1; then
    command -v "$1"
  elif [[ -x "${HOME}/.local/bin/$1" ]]; then
    printf '%s\n' "${HOME}/.local/bin/$1"
  else
    return 1
  fi
}
ANSIBLE_PLAYBOOK="$(find_tool ansible-playbook)" \
  || die "ansible-playbook not found. Install it with: pipx install ansible-core (see ansible/README.md)"
readonly ANSIBLE_PLAYBOOK
# backup.yml runs `ansible-vault` on this laptop: make sure it is the one that
# was installed next to ansible-playbook.
PATH="$(dirname -- "$ANSIBLE_PLAYBOOK"):${PATH}"
export PATH

# ---- Inventory --------------------------------------------------------------------
# Either an INLINE inventory from user@host[:port], or inventory.ini (the
# default in ansible.cfg). The trailing comma in "-i 203.0.113.10," tells
# Ansible "this is a list of hosts, not a file name".
inventory_args=()
ssh_host=""
ssh_port=""
if [[ -n "$target" ]]; then
  ssh_user="${target%%@*}"
  ssh_host="${target#*@}"
  if [[ "$ssh_host" == *:* ]]; then
    ssh_port="${ssh_host##*:}"
    ssh_host="${ssh_host%:*}"
  fi
  # Validate, so nothing odd ever reaches ssh or Ansible's command line.
  [[ "$ssh_user" =~ ^[A-Za-z0-9._][A-Za-z0-9._-]*$ ]] || die "Invalid user name in '$target'."
  [[ "$ssh_host" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]] \
    || die "Invalid host in '$target' (use an IPv4 address or a DNS name)."
  if [[ -n "$ssh_port" ]]; then
    # 10# = read as decimal, even with a leading zero (bash would assume octal).
    if ! [[ "$ssh_port" =~ ^[0-9]{1,5}$ ]] || ((10#$ssh_port < 1 || 10#$ssh_port > 65535)); then
      die "Invalid SSH port '$ssh_port' in '$target'."
    fi
  fi
  inventory_args=(-i "${ssh_host}," -e "ansible_user=${ssh_user}")
  [[ -z "$ssh_port" ]] || inventory_args+=(-e "ansible_port=${ssh_port}")
else
  [[ -f "${SCRIPT_DIR}/inventory.ini" ]] \
    || die "No target given and ${SCRIPT_DIR}/inventory.ini does not exist. Either pass user@host, or: cp ansible/inventory.example.ini ansible/inventory.ini (and edit it)."
fi

# ---- Vault password -----------------------------------------------------------------
# .vault_pass (git-ignored, created by ./bootstrap-secrets.sh) unlocks
# secrets/vault.yml. Without it, app.yml stops with "Attempting to decrypt but
# no vault secrets found"; docker.yml needs no vault.
# Ansible reads the file name from ANSIBLE_VAULT_PASSWORD_FILE - exported, so
# that `ansible-playbook` AND the `ansible-vault` commands it runs on this
# laptop (backup.yml encrypts the backups) use the same password.
VAULT_PASS_FILE="${ANSIBLE_VAULT_PASSWORD_FILE:-${SCRIPT_DIR}/.vault_pass}"
if [[ -f "$VAULT_PASS_FILE" ]]; then
  VAULT_PASS_FILE="$(cd -- "$(dirname -- "$VAULT_PASS_FILE")" && pwd -P)/$(basename -- "$VAULT_PASS_FILE")"
  export ANSIBLE_VAULT_PASSWORD_FILE="$VAULT_PASS_FILE"
  # Anyone who can read this file can decrypt every secret: owner only (600).
  if [[ -n "$(find "$VAULT_PASS_FILE" \( -perm -g=r -o -perm -o=r \) -print 2>/dev/null)" ]]; then
    warn "$VAULT_PASS_FILE is readable by other users. Fix: chmod 600 $VAULT_PASS_FILE"
  fi
else
  [[ -z "${ANSIBLE_VAULT_PASSWORD_FILE:-}" ]] || die "ANSIBLE_VAULT_PASSWORD_FILE points to '$ANSIBLE_VAULT_PASSWORD_FILE', which does not exist."
  if [[ -f "${SCRIPT_DIR}/secrets/vault.yml" ]]; then
    warn "${VAULT_PASS_FILE} not found - app.yml / site.yml cannot read secrets/vault.yml."
    warn "Restore it from your password manager, or pass --ask-vault-pass."
  fi
fi

# ---- --new-vm: forget the old host key ---------------------------------------------
# Prints "host port" for every server we are about to contact.
list_targets() {
  if [[ -n "$ssh_host" ]]; then
    printf '%s %s\n' "$ssh_host" "${ssh_port:-22}"
    return 0
  fi
  local inventory_cmd
  inventory_cmd="$(find_tool ansible-inventory)" || return 1
  # ansible-inventory prints the parsed inventory as JSON; _meta.hostvars has
  # each host's ansible_host / ansible_port (the alias is used if not set).
  (cd -- "$SCRIPT_DIR" && "$inventory_cmd" --list </dev/null 2>/dev/null) | python3 -c '
import json, sys
hostvars = json.load(sys.stdin).get("_meta", {}).get("hostvars", {})
for alias, hv in hostvars.items():
    print(hv.get("ansible_host", alias), hv.get("ansible_port", 22))
'
}

forget_host_key() {
  local host=$1 port=$2 entry
  local entries=("$host")
  # ssh saves keys for port 22 as "host", for other ports as "[host]:port".
  [[ "$port" == "22" ]] || entries+=("[${host}]:${port}")
  for entry in "${entries[@]}"; do
    if ssh-keygen -F "$entry" >/dev/null 2>&1; then
      ssh-keygen -R "$entry" >/dev/null 2>&1
      ok "forgot the old host key of ${entry} (backup: ~/.ssh/known_hosts.old)"
    else
      info "no saved host key for ${entry}"
    fi
  done
}

if [[ "$new_vm" == "1" ]]; then
  printf '%s==> New VM: forgetting old SSH host keys%s\n' "${C_BOLD}${C_BLUE}" "$C_RESET"
  targets="$(list_targets)" || die "Could not read the hosts from inventory.ini (is python3 installed?)."
  [[ -n "$targets" ]] || die "No hosts found in inventory.ini."
  while read -r host port; do
    forget_host_key "$host" "$port"
  done <<<"$targets"
  info "the new key is accepted on first contact (StrictHostKeyChecking=accept-new in ansible.cfg)"
fi

# ---- Run ---------------------------------------------------------------------------
# ANSIBLE_CONFIG pins the config file even if you have a ~/.ansible.cfg, and
# running from SCRIPT_DIR makes the relative paths in it (inventory, roles) work.
export ANSIBLE_CONFIG="${SCRIPT_DIR}/ansible.cfg"
cd -- "$SCRIPT_DIR"

# ${arr[@]+"${arr[@]}"} expands to nothing for an empty array - also on the old
# bash 3.2 that macOS ships, where a plain "${arr[@]}" fails under `set -u`.
cmd=("$ANSIBLE_PLAYBOOK" ${inventory_args[@]+"${inventory_args[@]}"} "$playbook" "$@")
printf '%s==> %s%s\n' "${C_BOLD}${C_BLUE}" "${cmd[*]}" "$C_RESET"
[[ -z "${ANSIBLE_VAULT_PASSWORD_FILE:-}" ]] || info "vault password file: ${ANSIBLE_VAULT_PASSWORD_FILE}"

status=0
"${cmd[@]}" || status=$?

# ansible-playbook exit codes: 0 ok, 2 a task failed, 3 host unreachable,
# 4 syntax/parser error, 5 bad options, 99 interrupted.
case "$status" in
  0)
    if [[ "$(basename -- "$playbook")" == "backup.yml" ]]; then
      printf '\n%sDone.%s The encrypted backups are listed above.\n' "${C_BOLD}${C_GREEN}" "$C_RESET"
    else
      printf '\n%sDone.%s Run it again any time: the second run should report changed=0.\n' "${C_BOLD}${C_GREEN}" "$C_RESET"
    fi
    ;;
  3)
    warn "Could not reach the server over SSH. Checklist:"
    warn "  * Is the VM running, and is this its current external IP?"
    warn "  * 'REMOTE HOST IDENTIFICATION HAS CHANGED' above? The VM was recreated: add --new-vm."
    warn "  * Does 'ssh <user>@<host>' work by hand (key loaded: ssh-add -l)?"
    ;;
  *) warn "ansible-playbook exited with status ${status}. The failing task and its message are shown above." ;;
esac
exit "$status"
