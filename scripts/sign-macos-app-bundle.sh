#!/usr/bin/env bash
# Ad-hoc seal the macOS .app and rebuild the DMG from the sealed app.
#
# WHY THIS EXISTS
# ---------------
# `cargo tauri build` with no signing identity leaves the main binary
# "linker-signed" with no sealed resources, which makes
# `codesign --verify --deep --strict` fail ("code has no resources but
# signature indicates they must be present") and Finder report the app as
# "damaged". Tauri's own signing (signingIdentity "-") fixes the seal but also
# applies the HARDENED RUNTIME, under which the PyInstaller Python sidecar
# cannot dlopen its bundled framework and never starts.
#
# So we seal the bundle ourselves with a plain ad-hoc signature and NO hardened
# runtime: this produces a valid, verifiable seal (no more "damaged") while
# keeping the sidecar runnable. It is NOT notarized and NOT a Developer ID
# signature — Gatekeeper still shows the normal "unidentified developer" prompt
# (right-click Open, or clear the quarantine attribute). Notarization is out of
# scope for these unsigned pre-1.0 builds.
#
# Override the identity with MACOS_SIGN_IDENTITY=... to use a real Developer ID
# (in which case you'd also want notarization, handled elsewhere).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

IDENTITY="${MACOS_SIGN_IDENTITY:--}"   # default: ad-hoc
APP_DIR="src-tauri/target/release/bundle/macos"
DMG_DIR="src-tauri/target/release/bundle/dmg"
APP="${1:-$(ls -d "$APP_DIR"/*.app 2>/dev/null | head -1 || true)}"

fail() { echo "FAIL: $1" >&2; exit 1; }
[ -n "$APP" ] && [ -d "$APP" ] || fail "no .app found under $APP_DIR (run the build first)"
echo "==> Sealing: $APP  (identity: $IDENTITY)"

# Deep ad-hoc sign the whole bundle in one pass. `--deep` recursively signs all
# nested code — the main binary, the bundled PyInstaller one-dir sidecar under
# Contents/Resources/sidecar/ (its launcher, ~180 .so/.dylib, and the embedded
# Python.framework) — and seals resources, so `codesign --verify --deep --strict`
# passes and Finder no longer reports the app as "damaged".
#
# Crucially there is NO `--options runtime`: the hardened runtime prevents the
# PyInstaller sidecar from dlopen-ing its bundled libraries, so it would never
# start. This is a plain ad-hoc seal — valid and verifiable, but NOT a Developer
# ID signature and NOT notarized (Gatekeeper still shows the normal
# "unidentified developer" prompt; clear the quarantine attribute or right-click
# Open). Notarization is out of scope for these unsigned pre-1.0 builds.
echo "    deep ad-hoc sign (no hardened runtime)"
codesign --force --deep --sign "$IDENTITY" "$APP"

echo "==> Verifying seal (codesign --verify --deep --strict)"
codesign --verify --deep --strict --verbose=2 "$APP" || fail "codesign verify failed after sealing"
echo "==> Seal OK"

# Rebuild the DMG from the sealed app (Tauri built the DMG before we re-signed,
# so it still contains the unsealed app). A simple compressed DMG with an
# /Applications drop target is sufficient for an unsigned pre-release.
if command -v hdiutil >/dev/null 2>&1; then
  OLD_DMG="$(ls "$DMG_DIR"/*.dmg 2>/dev/null | head -1 || true)"
  DMG_NAME="$(basename "${OLD_DMG:-Storage Agent Workbench.dmg}")"
  VOL_NAME="$(basename "$APP" .app)"
  mkdir -p "$DMG_DIR"
  STAGING="$(mktemp -d)"
  cp -R "$APP" "$STAGING/"
  ln -s /Applications "$STAGING/Applications"
  [ -n "$OLD_DMG" ] && rm -f "$OLD_DMG"
  echo "==> Rebuilding DMG from sealed app: $DMG_DIR/$DMG_NAME"
  hdiutil create -volname "$VOL_NAME" -srcfolder "$STAGING" -ov -format UDZO \
    "$DMG_DIR/$DMG_NAME" >/dev/null
  rm -rf "$STAGING"
  # Verify the app inside the freshly built DMG seals correctly too.
  MNT="$(mktemp -d)"
  hdiutil attach "$DMG_DIR/$DMG_NAME" -nobrowse -mountpoint "$MNT" >/dev/null
  DAPP="$(ls -d "$MNT"/*.app 2>/dev/null | head -1 || true)"
  if [ -n "$DAPP" ]; then
    codesign --verify --deep --strict "$DAPP" || { hdiutil detach "$MNT" >/dev/null 2>&1 || true; fail "DMG app seal verify failed"; }
    echo "==> DMG app seal OK"
  fi
  hdiutil detach "$MNT" >/dev/null 2>&1 || true
  rmdir "$MNT" 2>/dev/null || true
else
  echo "==> hdiutil not available; skipping DMG rebuild (ship the .app / .app.zip)."
fi

echo "==> Done. Sealed (ad-hoc, no hardened runtime); not notarized."
