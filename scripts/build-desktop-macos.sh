#!/usr/bin/env bash
# Build the macOS desktop app end to end (Phase 09).
#
# Steps: frontend build -> sidecar PyInstaller build + copy externalBin ->
# Tauri build. Uses `cargo tauri build` if the Tauri CLI is installed, otherwise
# falls back to `cargo build` (compiles + links the desktop binary; no .app
# bundle). No code signing / notarization / auto-update.
#
# Requirements: Rust toolchain, Node, Python 3.12+ with the sidecar venv deps
# (pip install -e ".[dev]" ".[packaging]").
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

# Make cargo available in non-login shells.
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

echo "==> [1/4] Building frontend"
( cd frontend && npm install && npm run build )

echo "==> [2/4] Building sidecar and copying externalBin"
python3 scripts/build-sidecar-for-tauri.py

echo "==> [3/4] cargo check"
( cd src-tauri && cargo check )

echo "==> [4/4] Tauri / cargo build"
if cargo tauri --version >/dev/null 2>&1; then
  echo "Tauri CLI found -> cargo tauri build (bundling; signing/notarization NOT performed)"
  ( cd src-tauri && cargo tauri build || {
      echo "NOTE: 'cargo tauri build' failed. The release binary still builds via 'cargo build';"
      echo "full .app bundling may require additional icon/signing config (intentionally skipped)."
      ( cd src-tauri && cargo build --release )
    } )
else
  echo "Tauri CLI not installed (install with: cargo install tauri-cli --locked)."
  echo "Falling back to 'cargo build --release' (compiles + links the desktop binary; no .app bundle)."
  ( cd src-tauri && cargo build --release )
fi

echo "==> Done."
echo "Debug binary:   src-tauri/target/debug/storage-agent-workbench"
echo "Release binary: src-tauri/target/release/storage-agent-workbench (if release build ran)"
echo "Bundles (if cargo tauri build succeeded): src-tauri/target/release/bundle/"
