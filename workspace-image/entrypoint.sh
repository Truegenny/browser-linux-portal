#!/usr/bin/env bash
# Workspace container entrypoint:
#   1. Bring up filebrowser (file manager UI) on port 7682, in background.
#   2. Exec ttyd on port 7681 in the foreground (tini watches it).
#
# Both bind 0.0.0.0 on the internal portal-net network — Caddy is the only
# ingress, so that's safe.

set -euo pipefail

# ---------------------------------------------------------------------------
# Filebrowser — drag-and-drop file manager, gated by Caddy basicauth (no
# filebrowser auth of its own).
# ---------------------------------------------------------------------------
FB_DB="${FB_DATABASE:-/tmp/filebrowser.db}"
FB_ROOT="${FB_ROOT:-/home/node}"
FB_PORT="${FB_PORT:-7682}"
FB_ADDRESS="${FB_ADDRESS:-0.0.0.0}"
# Default baseurl is set per-container by the portal:
#   FB_BASEURL=/u/<user>/files
# Fallback below is just for sanity if the env var is missing.
FB_BASEURL="${FB_BASEURL:-/files}"

# Initialize the filebrowser DB on every container start (we keep it in
# /tmp so it's recreated cleanly each time — there is no useful per-user
# state because auth is disabled).
rm -f "$FB_DB"
filebrowser config init --database "$FB_DB" >/dev/null
filebrowser config set --auth.method=noauth --database "$FB_DB" >/dev/null
# noauth still wants a "current user" record to attribute actions to.
filebrowser users add nobody nobody --perm.admin --database "$FB_DB" >/dev/null 2>&1 || true

filebrowser \
  --database "$FB_DB" \
  --root "$FB_ROOT" \
  --address "$FB_ADDRESS" \
  --port "$FB_PORT" \
  --baseurl "$FB_BASEURL" \
  > /tmp/filebrowser.log 2>&1 &

# ---------------------------------------------------------------------------
# ttyd — the in-browser bash terminal. Runs in foreground.
# ---------------------------------------------------------------------------
exec ttyd \
  -W \
  -p 7681 \
  -t fontSize=14 \
  -t 'theme={"background":"#0b0d10","foreground":"#d5d8dc"}' \
  -O \
  bash -l
