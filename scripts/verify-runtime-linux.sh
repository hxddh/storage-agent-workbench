#!/usr/bin/env bash
# Linux x64 runtime verification (Phase 12).
#
# Verifies the built release app + bundled sidecar: structure, direct sidecar
# /health, and (under a virtual display via xvfb-run when available) the app
# launch -> sidecar spawn -> /health -> quit -> cleanup lifecycle. No GUI screen
# inspection; no cloud/keyring secrets.
#
# Uses the raw release output (target/release): Tauri copies the externalBin
# sidecar next to the main binary, so this exercises the same spawn path the
# packaged app uses, without needing root to install the .deb in CI.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

REL="src-tauri/target/release"
MAIN_EXE="$REL/storage-agent-workbench"
SIDECAR="$REL/storage-agent-sidecar"

if [ ! -f "$MAIN_EXE" ]; then
  echo "ERROR: $MAIN_EXE not found. Run scripts/build-desktop-linux.sh first."
  exit 1
fi

run_verify() {
  python3 scripts/verify-runtime-common.py \
    --main-exe "$MAIN_EXE" \
    --sidecar "$SIDECAR" \
    --install-root "$REL" \
    "$@"
}

# Launch needs a display; use xvfb-run if present, else best-effort.
if command -v xvfb-run >/dev/null 2>&1; then
  echo "==> Using xvfb-run for headless GUI launch"
  xvfb-run -a python3 scripts/verify-runtime-common.py \
    --main-exe "$MAIN_EXE" --sidecar "$SIDECAR" --install-root "$REL" "$@"
else
  echo "==> xvfb-run not available; launch lifecycle is best-effort"
  run_verify "$@"
fi
