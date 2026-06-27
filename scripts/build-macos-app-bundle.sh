#!/usr/bin/env bash
# Build the macOS .app (and DMG, if the bundler can) for Storage Agent Workbench.
#
# Steps: frontend build -> one-file sidecar build + copy externalBin ->
# `cargo tauri build` (bundle active). Produces an UNSIGNED bundle. No code
# signing, notarization, or auto-update.
#
# Requires: Rust + tauri-cli (cargo install tauri-cli --locked), Node, and the
# sidecar venv deps (pip install -e "./sidecar[dev]" "./sidecar[packaging]").
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

echo "==> [1/4] Building frontend"
( cd frontend && npm install && npm run build )

echo "==> [2/4] Building sidecar + copying externalBin"
python3 scripts/build-sidecar-for-tauri.py

echo "==> [3/4] Verifying Tauri CLI"
if ! cargo tauri --version >/dev/null 2>&1; then
  echo "ERROR: Tauri CLI not installed. Run: cargo install tauri-cli --locked"
  exit 2
fi

echo "==> [4/5] cargo tauri build (unsigned bundle)"
( cd src-tauri && cargo tauri build )

echo "==> [5/5] Ad-hoc seal the .app + rebuild DMG (fixes the 'damaged' seal; no hardened runtime)"
bash scripts/sign-macos-app-bundle.sh

echo "==> Artifacts:"
APP_DIR="src-tauri/target/release/bundle/macos"
DMG_DIR="src-tauri/target/release/bundle/dmg"
ls -1 "$APP_DIR"/*.app 2>/dev/null || echo "  (no .app found in $APP_DIR)"
ls -1 "$DMG_DIR"/*.dmg 2>/dev/null || echo "  (no .dmg found in $DMG_DIR — see verify script / docs/release.md)"
echo "==> Done (ad-hoc sealed, not notarized; Gatekeeper warns on first open — see docs/release.md)."
