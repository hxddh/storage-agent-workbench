# Packaging

How the desktop app is assembled: a PyInstaller-bundled Python sidecar shipped
inside a Tauri v2 app and launched by the Rust shell.

> For the release flow (CI, multi-platform assets, versioning) see
> **[release.md](release.md)**. For macOS signing see **[signing.md](signing.md)**.

## Dev mode

Run the sidecar and frontend separately (no packaging needed):

```bash
# terminal 1 — sidecar
cd sidecar && python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
uvicorn app.main:app --reload --host 127.0.0.1 --port 8765

# terminal 2 — frontend
cd frontend && npm install && npm run dev   # http://127.0.0.1:1420
```

The frontend resolves the sidecar URL from `VITE_SIDECAR_URL` (if set) or the
default `http://127.0.0.1:8765`.

## Sidecar bundle: one-dir, not one-file

The sidecar is built with PyInstaller in **one-dir** mode (see
`sidecar/packaging/storage-agent-sidecar.spec`): the output is a folder
containing the `storage-agent-sidecar` executable plus an `_internal/` directory
of libraries.

This is deliberate. A **one-file** build self-extracts its whole archive to a
fresh temp directory on *every* launch, and on macOS Gatekeeper then re-scans
every extracted Mach-O at that new path — making cold start ~60s. One-dir keeps
the libraries at a stable path that Gatekeeper scans once, so cold start drops to
a few seconds (≈ the Python import time).

```bash
cd sidecar && pip install -e ".[packaging]"
python packaging/build_sidecar.py        # -> sidecar/dist/storage-agent-sidecar/ (a folder)
python packaging/smoke_test_sidecar.py   # starts it, checks /health, stops it
```

Packaged CLI (production never enables uvicorn `--reload`):

```bash
storage-agent-sidecar --host 127.0.0.1 --port 8765 --data-dir <path>
```

## Desktop app: bundle the sidecar as a resource

Because one-dir is a folder (not a single file), it is shipped as a Tauri
**resource** rather than an `externalBin`. The build wiring:

1. `scripts/build-sidecar-for-tauri.py` builds the one-dir bundle and stages it
   at `src-tauri/sidecar-dist/storage-agent-sidecar/`.
2. `tauri.conf.json` → `bundle.resources` maps that folder into the app's
   resource directory (`Contents/Resources/sidecar/` on macOS).
3. `src-tauri/src/lib.rs` resolves the inner executable under the resource dir
   and launches it directly with `std::process::Command` — no shell plugin, no
   shell capability.

```bash
# one command does frontend + sidecar one-dir + cargo tauri build + macOS seal:
scripts/build-desktop-macos.sh
# (Linux / Windows: scripts/build-desktop-linux.sh, scripts/build-desktop-windows.ps1)
```

At runtime the Rust shell picks a free localhost port, spawns the sidecar with
`STORAGE_AGENT_DATA_DIR` (the OS app-data dir) and `STORAGE_AGENT_PARENT_PID`
(so the sidecar exits if the app dies, never orphaned), exposes the URL via the
`get_sidecar_url` command, and kills the sidecar on exit. The frontend shows
sidecar status: **starting → connected | disconnected | error**.

## App data dir behavior

- All user data — SQLite DB, `runs/`, DuckDB files, reports, uploads — lives
  under the app data dir.
- Resolution: `STORAGE_AGENT_DATA_DIR` → `SAW_DATA_DIR` (legacy/dev) →
  `<repo>/data` (dev default). In production Tauri sets `STORAGE_AGENT_DATA_DIR`
  to the OS app-data dir.
- Paths recorded into reports / `tool_calls` / `audit_logs` stay relative.
- User data is **never** written to the install dir and **never** bundled.

## Secrets

Secrets (cloud AK/SK, session tokens, model API keys) live only in the encrypted
local vault (`security/keyring_store`, `secrets.enc`) in the app data dir, with
the master key protected per-OS (DPAPI / `0600` key file). They are never
bundled, never written to SQLite, and never logged.

## Notes & limitations

- The desktop build requires the Rust toolchain (`cargo`, `rustc`) and platform
  webview deps; sidecar + frontend can be built/tested without Rust.
- Bundling `duckdb` / `pyarrow` / `pandas` is heavy, so the bundle is large and
  builds take a few minutes.
- macOS builds are ad-hoc sealed, **not** notarized; see [signing.md](signing.md).
- No auto-update yet.

## Cross-platform builds

macOS arm64, Linux x64, and Windows x64 are built per-platform in CI (PyInstaller
does not reliably cross-compile, so the sidecar one-dir is produced on each OS).
`scripts/verify-runtime-{macos.sh,linux.sh,windows.ps1}` confirm the built app
launches, spawns the sidecar, serves `/health`, and cleans up on quit. See
**[release.md](release.md)** for the support matrix.
