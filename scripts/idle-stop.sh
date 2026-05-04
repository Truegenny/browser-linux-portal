#!/usr/bin/env bash
# Stop workspace containers that have had no Caddy access-log activity in
# the last $WORKSPACE_IDLE_HOURS hours. Run from cron, e.g.:
#   */15 * * * *  /opt/browser-linux-portal/scripts/idle-stop.sh

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -f "$ROOT/.env" ]]; then
  set -a; . "$ROOT/.env"; set +a
fi

IDLE_HOURS="${WORKSPACE_IDLE_HOURS:-2}"
CUTOFF=$(date -u -d "$IDLE_HOURS hours ago" +%s)

# Caddy access log path (inside the caddy container; readable from the
# portal container via the shared caddy-logs volume; readable on host via
# `docker compose exec caddy tail ...` or `docker volume inspect`).
LOG_VOLUME=$(docker volume inspect browser-linux-portal_caddy-logs -f '{{ .Mountpoint }}')
LOG_FILE="$LOG_VOLUME/access.log"

if [[ ! -f "$LOG_FILE" ]]; then
  echo "No access log at $LOG_FILE; nothing to do."
  exit 0
fi

# For each running ws-* container, look for the most recent access to /u/<user>/.
mapfile -t RUNNING < <(docker ps --filter "name=^ws-" --format '{{ .Names }}')

for c in "${RUNNING[@]}"; do
  user="${c#ws-}"
  # Find the most recent log line referencing /u/<user>/.
  last_seen=$(grep -F "\"uri\":\"/u/$user/" "$LOG_FILE" 2>/dev/null \
                | tail -n1 \
                | sed -nE 's/.*"ts":([0-9.]+).*/\1/p' \
                | awk -F. '{print $1}')
  if [[ -z "$last_seen" ]]; then
    # No record this rotation — assume idle.
    last_seen=0
  fi
  if (( last_seen < CUTOFF )); then
    echo "Stopping idle workspace $c (last seen: ${last_seen}, cutoff: ${CUTOFF})"
    docker stop "$c" >/dev/null
  fi
done
