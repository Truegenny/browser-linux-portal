#!/usr/bin/env bash
set -euo pipefail

# ttyd flags:
#   -W            writable (allow input)
#   -p 7681       port
#   -t fontSize   xterm theme tweak
#   -O            check origin disabled (Caddy proxies — origin won't match)
#   -m 1          max single client (one-tab-at-a-time per workspace; comment out for multi)
#   -i lo         deprecated; ttyd binds 0.0.0.0 by default (Caddy is the only ingress)
#
# Trailing args are the command launched in the PTY.
exec ttyd \
  -W \
  -p 7681 \
  -t fontSize=14 \
  -t 'theme={"background":"#0b0d10","foreground":"#d5d8dc"}' \
  -O \
  bash -l
