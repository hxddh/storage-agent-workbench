#!/usr/bin/env bash
# macOS arm64 runtime verification (Phase 12).
#
# Verifies the built .app: structure, bundled sidecar /health, app launch ->
# sidecar spawn -> /health -> quit -> cleanup, and that no user data is written
# under the .app. Pass --require-launch to make the GUI launch a hard gate
# (use locally; on a headless CI runner omit it so launch is best-effort).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

APP="$(ls -d src-tauri/target/release/bundle/macos/*.app 2>/dev/null | head -1 || true)"
if [ -z "$APP" ]; then
  echo "ERROR: no .app found. Run scripts/build-macos-app-bundle.sh first."
  exit 1
fi
MAIN_EXE="$APP/Contents/MacOS/storage-agent-workbench"
SIDECAR="$APP/Contents/MacOS/storage-agent-sidecar"

python3 scripts/verify-runtime-common.py \
  --main-exe "$MAIN_EXE" \
  --sidecar "$SIDECAR" \
  --install-root "$APP" \
  --app-bundle "$APP" \
  "$@"
