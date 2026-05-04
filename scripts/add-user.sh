#!/usr/bin/env bash
# Add (or replace) a user in caddy/users.users.
# Optionally also add to caddy/admins.users with --admin.
#
# Usage:
#   scripts/add-user.sh <username> [--admin]
#
# Username constraints (must match the portal's auth regex):
#   - lowercase a-z, 0-9, _, -
#   - 1..31 chars, must start with [a-z0-9]
#
# Generates a bcrypt hash with the official caddy CLI (run via docker so we
# don't need caddy installed on the host).

set -euo pipefail

ADMIN=0
USERNAME=""

for arg in "$@"; do
  case "$arg" in
    --admin) ADMIN=1 ;;
    -*) echo "Unknown flag: $arg" >&2; exit 2 ;;
    *)
      if [[ -n "$USERNAME" ]]; then echo "Too many args" >&2; exit 2; fi
      USERNAME="$arg"
      ;;
  esac
done

if [[ -z "$USERNAME" ]]; then
  echo "Usage: $0 <username> [--admin]" >&2
  exit 2
fi
if ! [[ "$USERNAME" =~ ^[a-z0-9][a-z0-9_-]{0,30}$ ]]; then
  echo "Invalid username '$USERNAME' — must match ^[a-z0-9][a-z0-9_-]{0,30}\$" >&2
  exit 2
fi

# Project root
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
USERS_FILE="$ROOT/caddy/users.users"
ADMINS_FILE="$ROOT/caddy/admins.users"

read -rsp "Password for $USERNAME: " PW; echo
read -rsp "Repeat:                   " PW2; echo
if [[ "$PW" != "$PW2" ]]; then echo "Passwords don't match" >&2; exit 1; fi
if (( ${#PW} < 8 )); then echo "Password must be at least 8 chars" >&2; exit 1; fi

echo "Hashing (bcrypt cost 14, takes ~1 second)..."
HASH=$(docker run --rm -i caddy:2 caddy hash-password --plaintext "$PW")

if [[ -z "$HASH" ]]; then echo "Hashing failed" >&2; exit 1; fi

# Replace existing line for this user, or append.
update_file() {
  local file="$1"
  if [[ ! -f "$file" ]]; then : > "$file"; fi
  # Strip any existing entry for this user (line starting with username + space).
  local tmp; tmp=$(mktemp)
  awk -v u="$USERNAME" '$1 != u { print }' "$file" > "$tmp"
  mv "$tmp" "$file"
  printf '%s %s\n' "$USERNAME" "$HASH" >> "$file"
  echo "  → wrote $file"
}

update_file "$USERS_FILE"
if (( ADMIN )); then
  update_file "$ADMINS_FILE"
fi

echo
echo "User '$USERNAME' updated$( ((ADMIN)) && echo ' (admin)' )."
echo "Reload Caddy to pick it up:"
echo "  docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile"
echo
if (( ADMIN )); then
  echo "Don't forget to add '$USERNAME' to ADMIN_USERS in .env so the portal grants admin access."
fi
