#!/usr/bin/env bash
# Workspace container entrypoint. Three services run in parallel inside the
# container — all bound to 0.0.0.0 on the internal portal-net network, all
# gated by Caddy basicauth at the proxy.
#
#   * filebrowser  (7682) — file manager
#   * KasmVNC      (7683) — XFCE4 desktop, HTML5 client + WebSocket
#   * ttyd         (7681) — bash terminal, FOREGROUND (tini supervises)
#
# Anything backgrounded here that crashes does not bring the container
# down — only ttyd does. That's fine; the dashboard "Listening ports"
# panel surfaces what's actually live, and Open-terminal stays usable
# even if VNC has hiccuped.

set -euo pipefail

# ---------------------------------------------------------------------------
# Filebrowser (pinned to v2.32.0 in the Dockerfile) — initialize a fresh DB
# with auth.method=noauth + a placeholder user, then start.
# ---------------------------------------------------------------------------
FB_DB="${FB_DATABASE:-/tmp/filebrowser.db}"
FB_ROOT_DIR="${FB_ROOT:-/home/node}"
FB_PORT="${FB_PORT:-7682}"
FB_ADDRESS="${FB_ADDRESS:-0.0.0.0}"
FB_BASEURL="${FB_BASEURL:-/files}"

rm -f "$FB_DB"

# Capture config init/set output to debug — previous runs suppressed
# errors and we lost visibility into why baseurl wasn't sticking.
{
  echo '--- config init ---'
  filebrowser config init --database "$FB_DB"
  echo '--- config set auth ---'
  filebrowser config set --auth.method=noauth --database "$FB_DB"
  echo '--- config set baseurl ---'
  filebrowser config set --baseurl="$FB_BASEURL" --database "$FB_DB"
  echo '--- users add ---'
  filebrowser users add nobody noauth_placeholder_unused_xx --perm.admin --database "$FB_DB"
  echo '--- config cat ---'
  filebrowser config cat --database "$FB_DB"
} > /tmp/filebrowser-init.log 2>&1 || true

# Keep FB_BASEURL env set AND pass --baseurl on the CLI so DB + env + flag
# all agree. Unsetting the env caused filebrowser to override the DB value
# with an empty string and 404 the configured base URL.
filebrowser \
  --database "$FB_DB" \
  --root "$FB_ROOT_DIR" \
  --address "$FB_ADDRESS" \
  --port "$FB_PORT" \
  --baseurl "$FB_BASEURL" \
  > /tmp/filebrowser.log 2>&1 &

# ---------------------------------------------------------------------------
# KasmVNC (vncserver wrapper) + XFCE4 — desktop stack. Background.
#
# Use the `vncserver` Perl wrapper rather than direct Xvnc so the HTML5
# client + httpd configuration come from the package's own logic (rather
# than us reproducing all of its httpd setup correctly by hand). To skip
# the wrapper's interactive "create user" prompt that loops forever on
# stdin-less background processes, we pre-seed a user record with
# kasmvncpasswd before launching.
#
# Per-container env from the portal:
#   VNC_PORT=7683
#   VNC_RESOLUTION=1280x800
# ---------------------------------------------------------------------------
VNC_PORT="${VNC_PORT:-7683}"
VNC_RESOLUTION="${VNC_RESOLUTION:-1280x800}"

mkdir -p /home/node/.vnc /tmp/runtime-node
chmod 700 /tmp/runtime-node

# Important: do NOT pre-create ~/.vnc/xstartup. The KasmVNC wrapper's
# select-de.sh asks "WARNING: xstartup will be overwritten y/N?" if one
# already exists, then fails when stdin is a pipe of "1\n" lines (none
# of which match y or N). Letting select-de.sh write its own xstartup
# the first time skips the overwrite prompt entirely.
rm -f /home/node/.vnc/xstartup

# Pre-seed a user record so the vncserver wrapper doesn't prompt. The
# password is never used (we run with -SecurityTypes None below; Caddy
# basicauth is the actual auth gate).
echo -e "kasm_unused_password_xx\nkasm_unused_password_xx\n" \
  | kasmvncpasswd -u kasm_user -w >/dev/null 2>&1 || true

# kasmvnc.yaml — set subpath so the HTML5 client's generated URLs (assets,
# WebSocket) include the /u/<user>/desktop prefix that Caddy proxies on.
# Without subpath, the JS uses absolute /websockify which 404s through
# our reverse proxy.
VNC_SUBPATH="${VNC_BASEURL:-/desktop}"
cat > /home/node/.vnc/kasmvnc.yaml <<YAML
network:
  protocol: http
  interface: 0.0.0.0
  websocket_port: ${VNC_PORT}
  use_ipv4: true
  use_ipv6: false
  subpath: ${VNC_SUBPATH}
  ssl:
    require_ssl: false
desktop:
  resolution:
    width: ${VNC_RESOLUTION%x*}
    height: ${VNC_RESOLUTION#*x}
YAML

# Launch via the wrapper. The newer KasmVNC 1.3.x wrapper always runs
# select-de.sh on first start which prompts for DE choice. With stdin
# being /dev/null in a background context, the read returns empty and
# the script bails. Piping `yes 1` keeps a continuous stream of "1\n"
# on stdin — select-de picks XFCE (option 1) and any subsequent prompts
# also get "1" which is the safe default for everything else.
#
# -SecurityTypes None disables VNC-layer auth (Caddy basicauth gates
# the URL); -disableBasicAuth disables KasmVNC's own basicauth layer.
yes 1 | vncserver :1 \
  -interface 0.0.0.0 \
  -websocketPort "${VNC_PORT}" \
  -SecurityTypes None \
  -geometry "${VNC_RESOLUTION}" \
  -depth 24 \
  -disableBasicAuth \
  > /tmp/kasmvnc.log 2>&1 &

# ---------------------------------------------------------------------------
# ttyd — the in-browser bash terminal. Runs in foreground (tini watches it).
# ---------------------------------------------------------------------------
exec ttyd \
  -W \
  -p 7681 \
  -t fontSize=14 \
  -t 'theme={"background":"#0b0d10","foreground":"#d5d8dc"}' \
  -O \
  bash -l
