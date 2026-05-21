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
# Filebrowser — fresh DB each start, --noauth CLI flag.
#
# filebrowser >=2.63 redesigned its routing and the pre-baked DB from
# image build returns 404 on every route. Starting from a clean DB and
# using --noauth at the command line (rather than baking auth.method
# into the DB) sidesteps the issue cleanly. The user volume preserves
# /home/node contents; only the DB at /tmp is ephemeral, which is fine
# because with --noauth there's no user state to keep.
# ---------------------------------------------------------------------------
FB_DB="${FB_DATABASE:-/tmp/filebrowser.db}"
FB_ROOT="${FB_ROOT:-/home/node}"
FB_PORT="${FB_PORT:-7682}"
FB_ADDRESS="${FB_ADDRESS:-0.0.0.0}"
FB_BASEURL="${FB_BASEURL:-/files}"

rm -f "$FB_DB"

filebrowser \
  --noauth \
  --database "$FB_DB" \
  --root "$FB_ROOT" \
  --address "$FB_ADDRESS" \
  --port "$FB_PORT" \
  --baseURL "$FB_BASEURL" \
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

# xstartup launches XFCE4 against the display Xvnc opens.
cat > /home/node/.vnc/xstartup <<'XSTARTUP'
#!/bin/sh
unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS
export XDG_RUNTIME_DIR=/tmp/runtime-node
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
export XDG_CURRENT_DESKTOP=XFCE
export XDG_SESSION_DESKTOP=xfce
exec dbus-launch --exit-with-session xfce4-session
XSTARTUP
chmod +x /home/node/.vnc/xstartup

# Pre-seed a user record so the vncserver wrapper doesn't prompt. The
# password is never used (we run with -SecurityTypes None below; Caddy
# basicauth is the actual auth gate).
echo -e "kasm_unused_password_xx\nkasm_unused_password_xx\n" \
  | kasmvncpasswd -u kasm_user -w >/dev/null 2>&1 || true

# kasmvnc.yaml — disable SSL (Caddy handles TLS upstream), set resolution.
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

# Launch via the wrapper. -SecurityTypes None disables VNC-layer auth.
vncserver :1 \
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
