# Sidecar packaging

PyInstaller packaging for the Storage Agent sidecar (Phase 08).

## Build

From the `sidecar/` directory:

```bash
pip install -e ".[dev]" ".[packaging]"
python packaging/build_sidecar.py
```

Output: `sidecar/dist/storage-agent-sidecar` (a single one-file executable, so it
fits Tauri's `externalBin`).

## Run the packaged sidecar

```bash
./dist/storage-agent-sidecar --host 127.0.0.1 --port 8765 \
    --data-dir "$HOME/Library/Application Support/StorageAgentWorkbench"
curl http://127.0.0.1:8765/health
```

Configuration (CLI args take precedence over env):

| Setting   | CLI            | Env                        | Default     |
|-----------|----------------|----------------------------|-------------|
| host      | `--host`       | `STORAGE_AGENT_HOST`       | `127.0.0.1` |
| port      | `--port`       | `STORAGE_AGENT_PORT`       | `8765`      |
| data dir  | `--data-dir`   | `STORAGE_AGENT_DATA_DIR`   | `<repo>/data` (dev) |

Production mode never enables uvicorn `--reload`.

## Smoke test

```bash
python packaging/smoke_test_sidecar.py
```

- PASS (exit 0): packaged sidecar started and `/health` returned `ok`.
- SKIP (exit 0): bundle not built — run `build_sidecar.py` first.
- FAIL (exit 1): bundle present but unhealthy.

The smoke test does not require AWS/BOS/MinIO, `OPENAI_API_KEY`, or real keyring
secrets.

## What is NOT bundled

The bundle contains code and library data only. It must never include `.env`,
the SQLite database, keyring contents, or `data/runs/` output. Secrets always
remain in the OS keychain; user data lives in the app data dir, never inside the
application bundle.

## subprocess usage

`build_sidecar.py` invokes PyInstaller's in-process Python API (no shell).
`smoke_test_sidecar.py` launches the packaged binary via `subprocess` — this is
the internal packaged-sidecar lifecycle only (the same action Tauri performs in
production). Neither script executes user-controlled commands, and the app
itself exposes no shell/subprocess tool.
