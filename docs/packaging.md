# Packaging

> **Storage Agent v1.01.0 packaging contract.** Unchanged from v0.96.0; v1.01 is a native Agent product-model pass.
>
> The desktop product is a Tauri v2 shell containing the production React bundle and a PyInstaller **one-dir** Python Sidecar resource. Packaging must preserve the same Agent Task runtime/safety behavior as development; it must not introduce a second execution path.

For publication flow see [`release.md`](release.md). For current signing/notarization status see [`signing.md`](signing.md).

## Runtime shape

```text
Storage Agent desktop process (Tauri)
  ├── packaged React/Vite frontend
  └── bundled Python Sidecar resource
        ├── FastAPI / SQLite / Agent runtime / tools
        ├── DuckDB local analysis
        └── encrypted secret vault integration
```

The Rust shell owns Sidecar lifecycle only. It does not expose a generic shell/command capability to the Agent.

## Development mode

Run Sidecar and frontend separately:

```bash
# terminal 1
cd sidecar
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
uvicorn app.main:app --reload --host 127.0.0.1 --port 8765

# terminal 2
cd frontend
npm install
npm run dev
```

The frontend targets `VITE_SIDECAR_URL` when explicitly set, otherwise the development localhost default.

Development may leave `STORAGE_AGENT_AUTH_TOKEN` unset. The packaged app must use the per-launch token path described below.

## PyInstaller Sidecar: one-dir

The Sidecar is built in PyInstaller one-dir mode using `sidecar/packaging/storage-agent-sidecar.spec`.

Representative output:

```text
sidecar/dist/storage-agent-sidecar/
  storage-agent-sidecar[.exe]
  _internal/
  ...
```

One-dir is intentional. A one-file bundle extracts itself to a new temporary location on each launch, which materially worsened macOS cold start and Gatekeeper scanning for the embedded Python runtime. Stable one-dir resources avoid that per-launch extraction path.

Build/smoke commands:

```bash
cd sidecar
pip install -e ".[packaging]"
python packaging/build_sidecar.py
python packaging/smoke_test_sidecar.py
```

The packaged executable supports the explicit Sidecar CLI used by the desktop launcher, including localhost host/port and application data directory.

## Tauri resource integration

Because the Sidecar is a directory, it is shipped as a Tauri **resource**, not as a generic shell command exposed to the frontend/Agent.

Build flow:

1. `scripts/build-sidecar-for-tauri.py` builds/stages the one-dir bundle under `src-tauri/sidecar-dist/`.
2. `src-tauri/tauri.conf.json` includes that directory in bundle resources.
3. Rust resolves the known packaged Sidecar executable inside the resource directory.
4. Rust launches that executable directly with `std::process::Command` using a fixed application-owned invocation.

This packaging use of `Command` is not an Agent tool and must never be generalized into arbitrary command execution.

## Packaged Sidecar lifecycle

At launch, the Tauri shell:

1. chooses a free localhost port;
2. resolves the OS application-data directory;
3. generates a random per-launch Sidecar auth token;
4. launches the known bundled Sidecar executable;
5. sets runtime environment including:
   - `STORAGE_AGENT_DATA_DIR`;
   - `STORAGE_AGENT_AUTH_TOKEN`;
   - `STORAGE_AGENT_PARENT_PID`;
6. exposes the resolved Sidecar URL and token to the webview through narrow Tauri commands;
7. waits for/observes Sidecar health through the normal application startup path;
8. terminates/cleans up the Sidecar on desktop exit.

The Sidecar binds to localhost. Packaged uvicorn access logging is disabled so the SSE query-token path cannot leak the per-launch token into access logs.

## App data directory

All mutable user/runtime data belongs under the application data directory, including:

- SQLite database;
- runs/execution data;
- uploaded/imported evidence;
- DuckDB files;
- reports;
- encrypted secret vault.

Resolution order used by current runtime code includes production `STORAGE_AGENT_DATA_DIR` plus supported development/test overrides such as `SAW_DATA_DIR` / `SAW_DB_PATH`.

Rules:

- production Tauri sets the application data directory explicitly;
- user data must never be written inside the installed application bundle;
- stored artifact paths should remain relative to the data root where possible;
- secrets are never baked into the app bundle.

## Secret vault in packaged builds

The packaged Sidecar uses the same encrypted local vault as source/dev runtime:

- AES-256-GCM vault data;
- DPAPI-protected master key on Windows;
- owner-only `0600` key file on macOS/Linux;
- SQLite stores only opaque secret references.

Packaging must not copy developer provider credentials into staged resources, installers, logs, test artifacts, or screenshots.

## Desktop build entry points

Current repository scripts provide platform-specific desktop builds, including:

```text
scripts/build-desktop-macos.sh
scripts/build-desktop-linux.sh
scripts/build-desktop-windows.ps1
```

The build composes frontend production output, Sidecar one-dir bundle, Tauri application, and platform-specific packaging/sealing steps.

Do not document a platform as supported merely because Tauri can theoretically target it; use the actual release matrix.

## Current release matrix

| Platform | Public artifact |
| --- | --- |
| macOS Apple Silicon | `.app.zip`, `.dmg` |
| Linux x64 | `.deb` |
| Windows x64 | NSIS setup `.exe` |

Current releases do not produce macOS x64/universal artifacts.

## macOS sealing

The default macOS distribution is ad-hoc signed and not notarized.

The repository's macOS signing/sealing script deep-signs the final app bundle in the configuration required for the bundled PyInstaller Sidecar to load, then verifies the seal. A real Developer ID/notarized distribution would require the separate hardened-runtime/entitlement/signing path described in [`signing.md`](signing.md).

Do not run the ad-hoc re-sign step on top of a future real Developer ID-signed/notarized artifact; that would replace the trusted signature.

## Runtime verification

Platform runtime-verification scripts and shared verification code check the built application rather than only checking that files exist.

Current verification is expected to cover relevant platform behavior such as:

- application bundle/package structure;
- known Sidecar resource presence;
- launch/Sidecar health;
- cleanup/lifecycle;
- data-directory safety;
- public product/resource naming where applicable.

Release-level product behavior is additionally covered by real-Sidecar E2E and the manual/automated smoke checklist in [`release-smoke-test.md`](release-smoke-test.md).

## Why packaging is architecture-sensitive

A package can launch successfully while still shipping the wrong frontend bundle or stale product semantics. Therefore packaging acceptance is not just `/health`.

For a release candidate:

- build from the exact verified source SHA;
- ensure the current frontend architecture/documentation contracts are in that source;
- run real-Sidecar E2E/visual-review gates;
- verify the final downloaded artifact using the Agent Task smoke checklist.

## Limitations

Current distribution limitations:

- macOS builds are ad-hoc signed, not notarized;
- Windows installers are not Authenticode-signed;
- no trusted auto-update chain;
- macOS public build is Apple Silicon only;
- PyInstaller/DuckDB/PyArrow/pandas make the desktop artifact comparatively large.

These are distribution constraints, not justification for changing the Agent runtime, safety model, or product architecture.
