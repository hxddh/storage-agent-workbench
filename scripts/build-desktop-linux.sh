#!/usr/bin/env bash
# Build the Linux x64 desktop app for Storage Agent Workbench (Phase 11).
#
# Steps: frontend build -> one-dir sidecar build + stage resource ->
# cargo check -> cargo build -> attempt `cargo tauri build --bundles deb`.
# Produces UNSIGNED artifacts. No signing, no auto-update.
#
# System deps (install before running; CI installs them explicitly):
#   sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev \
#       librsvg2-dev patchelf build-essential curl wget file libssl-dev \
#       libgtk-3-dev libayatana-appindicator3-dev
#
# Requires: Rust + tauri-cli, Node, Python 3.12+ with sidecar deps
#   (pip install -e "./sidecar[dev]" "./sidecar[packaging]").
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

echo "==> [1/5] Building frontend"
( cd frontend && npm install && npm run build )

echo "==> [2/5] Building sidecar one-dir + staging resource"
python3 scripts/build-sidecar-for-tauri.py

echo "==> [3/5] cargo check"
( cd src-tauri && cargo check )

echo "==> [4/5] cargo build"
( cd src-tauri && cargo build )

echo "==> [5/5] cargo tauri build (Linux .deb; unsigned)"
if cargo tauri --version >/dev/null 2>&1; then
  ( cd src-tauri && cargo tauri build --bundles deb ) || {
    echo "NOTE: bundling failed (often WebKitGTK / distro deps). The binary still"
    echo "builds via 'cargo build'. See docs/release.md for required system deps."
  }
else
  echo "Tauri CLI not installed (cargo install tauri-cli --locked). Skipping bundle."
fi

echo "==> Artifacts:"
ls -1 src-tauri/target/release/bundle/deb/*.deb 2>/dev/null || echo "  (no .deb produced)"
python3 scripts/verify-desktop-artifacts.py || true
echo "==> Done (unsigned Linux build)."
