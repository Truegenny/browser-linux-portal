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
# filebrowser auth of its own). The DB is pre-built at image build time
# at /usr/local/share/filebrowser/filebrowser.db with auth.method=noauth
# and a default user; we just copy it to /tmp on each container start so
# every container gets a clean known-good state.
# ---------------------------------------------------------------------------
FB_DB="${FB_DATABASE:-/tmp/filebrowser.db}"
FB_ROOT="${FB_ROOT:-/home/node}"
FB_PORT="${FB_PORT:-7682}"
FB_ADDRESS="${FB_ADDRESS:-0.0.0.0}"
# Default baseurl is set per-container by the portal:
#   FB_BASEURL=/u/<user>/files
FB_BASEURL="${FB_BASEURL:-/files}"

cp -f /usr/local/share/filebrowser/filebrowser.db "$FB_DB"

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
