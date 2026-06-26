#!/usr/bin/env bash
# Verify the macOS .app bundle (Phase 10).
#
# Checks: the .app exists, the main app binary is present, the bundled sidecar
# (Tauri externalBin) is embedded, the bundle ships no user/app data, and the
# embedded sidecar can serve /health. Does NOT require a GUI session, AWS/BOS/
# OpenAI credentials, signing, or notarization.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

APP_GLOB="src-tauri/target/release/bundle/macos"
APP="$(ls -d "$APP_GLOB"/*.app 2>/dev/null | head -1 || true)"
fail() { echo "FAIL: $1"; exit 1; }

[ -n "$APP" ] || fail "no .app found under $APP_GLOB (run scripts/build-macos-app-bundle.sh)"
echo "==> Found app bundle: $APP"

# Main app binary
APP_BIN_DIR="$APP/Contents/MacOS"
[ -d "$APP_BIN_DIR" ] || fail "missing $APP_BIN_DIR"
MAIN_BIN="$(ls "$APP_BIN_DIR" | grep -v 'storage-agent-sidecar' | head -1 || true)"
[ -n "$MAIN_BIN" ] && [ -f "$APP_BIN_DIR/$MAIN_BIN" ] || fail "main app binary not found in $APP_BIN_DIR"
echo "==> Main binary: Contents/MacOS/$MAIN_BIN"

# Embedded sidecar (externalBin). Tauri strips the target-triple suffix when
# copying it into Contents/MacOS/.
SIDECAR="$(ls "$APP_BIN_DIR" | grep 'storage-agent-sidecar' | head -1 || true)"
[ -n "$SIDECAR" ] && [ -f "$APP_BIN_DIR/$SIDECAR" ] || fail "bundled sidecar not found in $APP_BIN_DIR"
echo "==> Bundled sidecar: Contents/MacOS/$SIDECAR"

# The bundle must NOT ship user/app data.
if find "$APP" -type d -name 'runs' -o -name 'data' 2>/dev/null | grep -q .; then
  fail "bundle unexpectedly contains a data/runs directory"
fi
if find "$APP" -type f \( -name '*.duckdb' -o -name 'app.db' -o -name '.env' \) 2>/dev/null | grep -q .; then
  fail "bundle unexpectedly contains user data / secrets"
fi
echo "==> No user/app data shipped in bundle: OK"

# Runtime check: the embedded sidecar serves /health (proves externalBin works).
PORT=8782
DATA_DIR="$(mktemp -d)"
echo "==> Launching embedded sidecar for /health check (data_dir in temp, no creds)"
STORAGE_AGENT_DATA_DIR="$DATA_DIR" "$APP_BIN_DIR/$SIDECAR" --host 127.0.0.1 --port "$PORT" >/tmp/saw-bundle-sidecar.log 2>&1 &
PID=$!
ok=0
for _ in $(seq 1 60); do
  if curl -s -m 2 "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"status":"ok"'; then ok=1; break; fi
  sleep 2
done
kill "$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true
[ "$ok" = "1" ] || fail "embedded sidecar did not report healthy (see /tmp/saw-bundle-sidecar.log)"
echo "==> Embedded sidecar /health: OK"

echo "==> PASS (unsigned bundle; GUI launch is verified manually — see docs/release.md)."
