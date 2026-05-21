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
# Filebrowser — copy pre-baked DB and launch in background.
# ---------------------------------------------------------------------------
FB_DB="${FB_DATABASE:-/tmp/filebrowser.db}"
FB_ROOT="${FB_ROOT:-/home/node}"
FB_PORT="${FB_PORT:-7682}"
FB_ADDRESS="${FB_ADDRESS:-0.0.0.0}"
FB_BASEURL="${FB_BASEURL:-/files}"

cp -f /usr/local/share/filebrowser/filebrowser.db "$FB_DB"

filebrowser \
  --database "$FB_DB" \
  --root "$FB_ROOT" \
  --address "$FB_ADDRESS" \
  --port "$FB_PORT" \
  --baseURL "$FB_BASEURL" \
  > /tmp/filebrowser.log 2>&1 &

# ---------------------------------------------------------------------------
# KasmVNC (Xvnc) + XFCE4 — desktop stack. Background.
#
# We bypass the `vncserver` Perl wrapper and call Xvnc directly. The wrapper
# interactively prompts for user/DE setup on first run and loops forever
# when stdin is /dev/null (background process). Xvnc binary itself is happy
# without that setup.
#
# Per-container env from the portal:
#   VNC_BASEURL=/u/<user>/desktop   ← reserved for future config; KasmVNC
#                                     follows the X-Forwarded headers Caddy
#                                     sends, so this isn't actively used here.
#   VNC_PORT=7683
#   VNC_RESOLUTION=1280x800
# ---------------------------------------------------------------------------
VNC_BASEURL="${VNC_BASEURL:-/desktop}"
VNC_PORT="${VNC_PORT:-7683}"
VNC_RESOLUTION="${VNC_RESOLUTION:-1280x800}"

# Locate the HTML5 client. Recent KasmVNC packages put it at one of these.
KASM_WWW=""
for d in /usr/share/kasmvnc/www /usr/share/kasmvncserver/www /usr/local/share/kasmvnc/www; do
  if [ -d "$d" ]; then KASM_WWW="$d"; break; fi
done
if [ -z "$KASM_WWW" ]; then
  echo "[desktop] WARN: KasmVNC www directory not found; HTML client unavailable." >&2
fi

mkdir -p /home/node/.vnc /tmp/runtime-node
chmod 700 /tmp/runtime-node
touch /home/node/.Xauthority
chmod 600 /home/node/.Xauthority

# KasmVNC YAML — disable SSL (Caddy handles TLS), set resolution. The
# wrapper script reads this; Xvnc directly reads only some fields, but
# the values it does honor are enough for our use.
cat > /home/node/.vnc/kasmvnc.yaml <<YAML
network:
  protocol: http
  interface: 0.0.0.0
  websocket_port: ${VNC_PORT}
  use_ipv4: true
  use_ipv6: false
  ssl:
    require_ssl: false
desktop:
  resolution:
    width: ${VNC_RESOLUTION%x*}
    height: ${VNC_RESOLUTION#*x}
YAML

# Start Xvnc directly. -SecurityTypes None disables VNC-layer auth (Caddy
# basicauth gates the URL). -httpd serves the HTML5 client on the same
# websocketPort. -rfbport -1 disables the raw TCP VNC port.
#
# NOTE: there is NO `-httpPort` flag in Xvnc. `-websocketPort` serves
# both the HTTP HTML/asset endpoint AND the WebSocket upgrade on the
# same port. Including `-httpPort` kills Xvnc at startup with
# "(EE) Unrecognized option: -httpPort".
(
  Xvnc :1 \
    -interface 0.0.0.0 \
    -websocketPort "${VNC_PORT}" \
    -SecurityTypes None \
    -geometry "${VNC_RESOLUTION}" \
    -depth 24 \
    ${KASM_WWW:+-httpd "$KASM_WWW"} \
    -rfbport -1 \
    -ac \
    -disableBasicAuth \
    -auth /home/node/.Xauthority \
    2>&1 | sed 's/^/[xvnc] /'
) > /tmp/kasmvnc.log 2>&1 &

# Wait briefly for X to come up before starting XFCE.
sleep 1

# Launch XFCE4 on the new display.
(
  export DISPLAY=:1
  export XDG_RUNTIME_DIR=/tmp/runtime-node
  export XDG_CURRENT_DESKTOP=XFCE
  export XDG_SESSION_DESKTOP=xfce
  export XAUTHORITY=/home/node/.Xauthority
  unset SESSION_MANAGER
  unset DBUS_SESSION_BUS_ADDRESS
  exec dbus-launch --exit-with-session xfce4-session
) > /tmp/xfce.log 2>&1 &

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
