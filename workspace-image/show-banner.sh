#!/usr/bin/env bash
# Print the admin announcement banner, if one is active.
#
# The portal writes the current banner text to /run/claudelab/banner via the
# Docker socket (on container create/start and whenever an admin changes the
# banner). The workspace itself can't fetch it from the portal — workspace-net
# is isolated from portal:3000 by design — so this file is the delivery point.
# Empty / missing file == no banner. Called from ~/.bashrc on each new shell.

f=/run/claudelab/banner
[ -s "$f" ] || exit 0

printf '\n\033[1;33m📢 Announcement\033[0m\n'
sed 's/^/   /' "$f"
printf '\n'
