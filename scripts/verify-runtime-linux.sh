#!/usr/bin/env bash
# Linux x64 runtime verification (Phase 12).
#
# Verifies the built release app + bundled sidecar: structure, direct sidecar
# /health, and app data dir not under the install dir. The app launch lifecycle
# is best-effort: pass --require-launch to run it under a virtual display (xvfb),
# or --skip-launch to skip it (used in headless CI — GUI launch is verified on a
# real desktop). No GUI screen inspection; no cloud/keyring secrets.
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
# Fallback to the externalBin source if Tauri did not stage a copy next to the binary.
[ -f "$SIDECAR" ] || SIDECAR="src-tauri/binaries/storage-agent-sidecar-x86_64-unknown-linux-gnu"

if [ ! -f "$MAIN_EXE" ]; then
  echo "ERROR: $MAIN_EXE not found. Run scripts/build-desktop-linux.sh first."
  exit 1
fi

# Only spin up a virtual display when we will actually launch the GUI.
want_launch=1
for a in "$@"; do [ "$a" = "--skip-launch" ] && want_launch=0; done

if [ "$want_launch" = "1" ] && command -v xvfb-run >/dev/null 2>&1; then
  echo "==> Using xvfb-run for headless GUI launch"
  xvfb-run -a python3 scripts/verify-runtime-common.py \
    --main-exe "$MAIN_EXE" --sidecar "$SIDECAR" --install-root "$REL" "$@"
else
  python3 scripts/verify-runtime-common.py \
    --main-exe "$MAIN_EXE" --sidecar "$SIDECAR" --install-root "$REL" "$@"
fi
