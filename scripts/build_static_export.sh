#!/usr/bin/env bash
# Build the static GitHub-Pages demo export (out/).
#
# - Moves src/app/api aside: route handlers cannot exist in a static export.
# - Builds with the in-browser demo engine enabled (NEXT_PUBLIC_PAYPHONE_DEMO=1)
#   and the project-page base path (/payphone).
# - Restores everything afterwards; the normal standalone build is untouched.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ -d src/app/api ]; then
  mv src/app/api .api-backup
  trap 'mv .api-backup src/app/api' EXIT
fi

rm -rf out
# `next build` directly: package.json's `build` post-steps copy the standalone
# bundle, which does not exist in an export build.
PAYPHONE_STATIC_EXPORT=1 \
PAYPHONE_BASE_PATH=/payphone \
NEXT_PUBLIC_PAYPHONE_DEMO=1 \
NEXT_TELEMETRY_DISABLED=1 \
bunx next build

echo "static export ready: out/"
