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
  --baseurl "$FB_BASEURL" \
  > /tmp/filebrowser.log 2>&1 &

# ---------------------------------------------------------------------------
# KasmVNC + XFCE4 — desktop stack. Background.
#
# KasmVNC's `vncserver` wrapper script:
#   1. Reads ~/.vnc/kasmvnc.yaml for runtime config (subpath, security, etc.)
#   2. Starts Xvnc :1 (combined X server + VNC + HTML/WebSocket on one port)
#   3. Runs ~/.vnc/xstartup which launches XFCE4
#
# Per-container env from the portal:
#   VNC_BASEURL=/u/<user>/desktop   ← passed via Docker env
#   VNC_PORT=7683
#   VNC_RESOLUTION=1280x800
# ---------------------------------------------------------------------------
VNC_BASEURL="${VNC_BASEURL:-/desktop}"
VNC_PORT="${VNC_PORT:-7683}"
VNC_RESOLUTION="${VNC_RESOLUTION:-1280x800}"

mkdir -p /home/node/.vnc

cat > /home/node/.vnc/xstartup <<'XSTARTUP'
#!/bin/sh
# Launched by Xvnc on display :1. Wipe any inherited X env that could
# confuse XFCE, then start a real dbus-launch + xfce4-session.
unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS
export XDG_RUNTIME_DIR=/tmp/runtime-node
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
export XDG_CURRENT_DESKTOP=XFCE
export XDG_SESSION_DESKTOP=xfce
exec dbus-launch --exit-with-session xfce4-session
XSTARTUP
chmod +x /home/node/.vnc/xstartup

# KasmVNC config — disable HTTPS (Caddy handles TLS upstream), no auth
# (Caddy basicauth gates the proxy), and set the subpath so KasmVNC's
# generated HTML uses the right URL prefix in its asset and WebSocket
# references.
cat > /home/node/.vnc/kasmvnc.yaml <<YAML
network:
  protocol: http
  interface: 0.0.0.0
  websocket_port: ${VNC_PORT}
  use_ipv4: true
  use_ipv6: false
  ssl:
    require_ssl: false
  udp:
    public_ip: 127.0.0.1
desktop:
  resolution:
    width: ${VNC_RESOLUTION%x*}
    height: ${VNC_RESOLUTION#*x}
runtime_configuration:
  allow_client_to_override_kasm_server_settings: true
YAML

# Start the VNC server in the background. -SecurityTypes None disables
# auth at the VNC layer (Caddy is the gate). Output to a log so a
# misconfig is visible via the file manager / terminal.
vncserver :1 \
  -interface 0.0.0.0 \
  -websocketPort "${VNC_PORT}" \
  -httpPort "${VNC_PORT}" \
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
