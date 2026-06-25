# Packaging (Phase 08)

How the desktop app is assembled: a PyInstaller-bundled Python sidecar launched
by the Tauri v2 shell.

## Dev mode

Run the sidecar and frontend separately (no packaging needed):

```bash
# terminal 1 — sidecar
cd sidecar && source .venv/bin/activate && pip install -e ".[dev]"
uvicorn app.main:app --reload --host 127.0.0.1 --port 8765

# terminal 2 — frontend
cd frontend && npm install && npm run dev   # http://127.0.0.1:1420
```

The frontend resolves the sidecar URL from `VITE_SIDECAR_URL` (if set) or the
default `http://127.0.0.1:8765`:

```bash
VITE_SIDECAR_URL=http://127.0.0.1:8765 npm run dev
```

## Build the sidecar

```bash
cd sidecar && pip install -e ".[packaging]"
python packaging/build_sidecar.py        # one-file -> sidecar/dist/storage-agent-sidecar
python packaging/smoke_test_sidecar.py   # starts it, checks /health, stops it
```

The packaged sidecar CLI:

```bash
storage-agent-sidecar --host 127.0.0.1 --port 8765 --data-dir <path>
```

Production mode never enables uvicorn `--reload`.

## Build the desktop app

Requires the Rust toolchain (`cargo`, `rustc`) and platform webview deps.

```bash
# place the built sidecar where Tauri expects it (target-triple suffix)
mkdir -p src-tauri/binaries
cp sidecar/dist/storage-agent-sidecar \
   src-tauri/binaries/storage-agent-sidecar-$(rustc -Vv | sed -n 's/host: //p')

cd src-tauri && cargo tauri build   # or: cargo tauri dev
```

At runtime the Tauri shell picks a free localhost port, spawns the sidecar with
`STORAGE_AGENT_DATA_DIR` set to the OS app-data dir, exposes the URL via the
`get_sidecar_url` command, and kills the sidecar on exit. The frontend shows
sidecar status: **starting → connected | disconnected | error**.

## App data dir behavior

- All user data — SQLite DB, `runs/`, DuckDB files, reports, uploads — lives
  under the app data dir.
- Resolution: `STORAGE_AGENT_DATA_DIR` → `SAW_DATA_DIR` (legacy/dev) →
  `<repo>/data` (dev default). In production Tauri sets
  `STORAGE_AGENT_DATA_DIR` to the OS app-data dir.
- Paths recorded into reports / `tool_calls` / `audit_logs` remain relative.
- User data is **never** written to the application install dir, and is **never**
  bundled into the app.

## Secrets

Secrets (cloud AK/SK, session tokens, model API keys) remain in the OS keychain
via `keyring`. They are never bundled, never written to SQLite, and never logged.

## Known limitations (Phase 08)

- **Rust toolchain required for the desktop build.** In the current development
  environment `cargo`/`rustc` are not installed, so `cargo tauri dev/build` have
  not been run or verified here. The Tauri Rust integration follows the standard
  v2 sidecar pattern and must be built on a machine with Rust.
- **No code signing / notarization.**
- **No auto-update.**
- PyInstaller bundling of `duckdb`/`pyarrow`/`pandas` is heavy; build times and
  bundle size are significant. The Agents SDK is bundled but agent mode still
  fails cleanly without a configured model API key.
