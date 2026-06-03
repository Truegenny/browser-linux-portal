#!/usr/bin/env bash
# Build the workspace container image. Run this once on initial setup
# and again whenever you change workspace-image/Dockerfile.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Pick up .env if present so WORKSPACE_IMAGE can be overridden.
if [[ -f "$ROOT/.env" ]]; then
  set -a; . "$ROOT/.env"; set +a
fi

TAG="${WORKSPACE_IMAGE:-claudelab-workspace:latest}"

echo "Building $TAG ..."
docker build -t "$TAG" "$ROOT/workspace-image"
echo
echo "Built $TAG."
echo "Existing user containers will only pick up the new image after they"
echo "are destroyed and re-created (Admin → Destroy, then user clicks Create)."
