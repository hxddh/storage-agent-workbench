#!/usr/bin/env bash
# Verify the desktop build prerequisites and compile/link the app (Phase 09).
#
# Checks the sidecar externalBin is present, then runs cargo check + cargo build.
# No signing / notarization. No secrets, no cloud credentials needed.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

echo "==> Checking sidecar externalBin"
TRIPLE="$(rustc -Vv 2>/dev/null | sed -n 's/^host: //p')"
if [ -z "${TRIPLE:-}" ]; then
  echo "ERROR: rustc not found; install Rust (https://rustup.rs)."
  exit 2
fi
BIN="src-tauri/binaries/storage-agent-sidecar-${TRIPLE}"
if [ ! -f "$BIN" ]; then
  echo "ERROR: sidecar binary missing at $BIN"
  echo "Run: python3 scripts/build-sidecar-for-tauri.py"
  exit 1
fi
echo "Found: $BIN"

echo "==> cargo check"
( cd src-tauri && cargo check )

echo "==> cargo build"
( cd src-tauri && cargo build )

ART="src-tauri/target/debug/storage-agent-workbench"
echo "==> Artifact: $ART"
ls -la "$ART" || { echo "ERROR: expected artifact not found"; exit 1; }
echo "==> Verify OK (no signing/notarization performed)."
