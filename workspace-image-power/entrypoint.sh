#!/usr/bin/env bash
# POWER workspace container entrypoint. Same three-service model as the lite
# image, but the desktop is KDE Plasma (X11) instead of XFCE, defaulting to a
# larger resolution. Services:
#
#   * filebrowser  (7682) — file manager
#   * KasmVNC      (7683) — KDE Plasma desktop, HTML5 client + WebSocket
#   * ttyd         (7681) — bash terminal, FOREGROUND (tini supervises)
#
# Only ttyd in the foreground keeps the container alive; a desktop hiccup
# never takes the workspace down. The home dir / volume / user are identical
# to the lite image (node @ uid 1000, /home/node) so the same ws-<user>-home
# volume works across tiers.

set -euo pipefail

# ---------------------------------------------------------------------------
# Filebrowser — fresh DB with auth.method=noauth + placeholder user, then run.
# ---------------------------------------------------------------------------
FB_DB="${FB_DATABASE:-/tmp/filebrowser.db}"
FB_ROOT_DIR="${FB_ROOT:-/home/node}"
FB_PORT="${FB_PORT:-7682}"
FB_ADDRESS="${FB_ADDRESS:-0.0.0.0}"
FB_BASEURL="${FB_BASEURL:-/files}"

rm -f "$FB_DB"

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

filebrowser \
  --database "$FB_DB" \
  --root "$FB_ROOT_DIR" \
  --address "$FB_ADDRESS" \
  --port "$FB_PORT" \
  --baseurl "$FB_BASEURL" \
  > /tmp/filebrowser.log 2>&1 &

# ---------------------------------------------------------------------------
# KasmVNC + KDE Plasma — desktop stack. Background.
#
# Power tier always sets ENABLE_DESKTOP=1, but we keep the guard so the image
# degrades to terminal-only if it's ever launched without it.
#
# Per-container env from the portal:
#   ENABLE_DESKTOP=0|1
#   VNC_PORT=7683
#   VNC_RESOLUTION=1920x1080   (power default; larger than lite's 1280x800)
# ---------------------------------------------------------------------------
if [[ "${ENABLE_DESKTOP:-0}" == "1" ]]; then
VNC_PORT="${VNC_PORT:-7683}"
VNC_RESOLUTION="${VNC_RESOLUTION:-1920x1080}"

mkdir -p /home/node/.vnc /tmp/runtime-node /home/node/.config
chmod 700 /tmp/runtime-node

# Disable the KDE screen locker entirely. The node user has NO system password
# (auth lives at oauth2-proxy), so a lock screen — triggered by idle timeout or
# a KasmVNC disconnect/reconnect — would be an unrecoverable lockout: there is
# no password that unlocks it. Written on every start so it holds regardless of
# any stale config already on the home volume. (A matching system-wide default
# is baked at /etc/xdg/kscreenlockerrc, but user config wins, so we force it.)
cat > /home/node/.config/kscreenlockerrc <<'KRC'
[Daemon]
Autolock=false
LockOnResume=false
KRC

# Let select-de.sh write its own xstartup the first time (an existing
# xstartup triggers an overwrite prompt that hangs a stdin-less process).
rm -f /home/node/.vnc/xstartup

# Pre-seed a KasmVNC user record so the wrapper doesn't prompt. Password is
# never used (we run -SecurityTypes None; Caddy/oauth2-proxy is the auth gate).
echo -e "kasm_unused_password_xx\nkasm_unused_password_xx\n" \
  | kasmvncpasswd -u kasm_user -w >/dev/null 2>&1 || true

# KasmVNC v1.3.3 has no `subpath` config key — Caddy redirects the bare
# desktop URL to vnc.html?path=u/<user>/desktop/websockify so the HTML5
# client uses the prefixed WebSocket path.
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

# Launch the X server via the wrapper (`yes 1` answers the DE prompt). The
# wrapper writes a default twm+xterm xstartup regardless, so once Xvnc :1 is
# up we kill twm/xterm and start a real KDE Plasma session on the same display.
yes 1 | vncserver :1 \
  -interface 0.0.0.0 \
  -websocketPort "${VNC_PORT}" \
  -SecurityTypes None \
  -geometry "${VNC_RESOLUTION}" \
  -depth 24 \
  -disableBasicAuth \
  > /tmp/kasmvnc.log 2>&1 &

# Wait for Xvnc :1, then replace the wrapper's twm/xterm with KDE Plasma.
sleep 3
pkill -x twm   2>/dev/null || true
pkill -x xterm 2>/dev/null || true
(
  export DISPLAY=:1
  export XDG_RUNTIME_DIR=/tmp/runtime-node
  export XDG_CURRENT_DESKTOP=KDE
  export XDG_SESSION_DESKTOP=KDE
  export DESKTOP_SESSION=plasma
  # KDE needs a working menu cache dir; keep it off the home volume so a
  # stale cache from a different image build can't wedge the session.
  export KDECACHE=/tmp/kde-cache
  mkdir -p "$KDECACHE"
  unset SESSION_MANAGER
  unset DBUS_SESSION_BUS_ADDRESS
  # startplasma-x11 is the X11 Plasma session launcher. dbus-launch gives it
  # the session bus Plasma components (plasmashell, kwin, krunner) need.
  exec dbus-launch --exit-with-session startplasma-x11
) > /tmp/plasma.log 2>&1 &
else
  echo "ENABLE_DESKTOP!=1 — skipping KasmVNC/KDE startup (terminal mode)." \
    > /tmp/kasmvnc.log
fi

# ---------------------------------------------------------------------------
# ttyd — the in-browser bash terminal. Foreground (tini watches it).
# ---------------------------------------------------------------------------
exec ttyd \
  -W \
  -p 7681 \
  -t fontSize=14 \
  -t 'theme={"background":"#0b0d10","foreground":"#d5d8dc"}' \
  -O \
  bash -l
