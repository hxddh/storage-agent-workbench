# Release (desktop) — Phase 09

Desktop release hardening for Storage Agent Workbench. This documents the
**local macOS build flow** and current limitations. There is **no** code
signing, notarization, or auto-update yet.

## Prerequisites

- Rust (stable) — <https://rustup.rs>; then `. "$HOME/.cargo/env"`
- Node.js 20+
- Python 3.12+ with sidecar deps: `pip install -e "./sidecar[dev]" -e "./sidecar[packaging]"`
- macOS with Xcode Command Line Tools (WebKit ships with the OS)

## One-command macOS app bundle (Phase 10)

```bash
bash scripts/build-macos-app-bundle.sh    # builds the unsigned .app (+ DMG)
bash scripts/verify-macos-app-bundle.sh   # checks the .app + embedded sidecar /health
```

`build-macos-app-bundle.sh`: frontend build → PyInstaller one-file sidecar +
copy to the Tauri `externalBin` path → `cargo tauri build` (bundle active).

Artifacts:

```
src-tauri/target/release/bundle/macos/*.app   # the application bundle
src-tauri/target/release/bundle/dmg/*.dmg      # disk image (if the bundler produced one)
```

The bundled sidecar is embedded at `Contents/MacOS/storage-agent-sidecar` inside
the `.app` (Tauri strips the target-triple suffix on copy).

### Opening the UNSIGNED app (Gatekeeper)

The `.app` is **unsigned and not notarized**, so macOS Gatekeeper will block it
on first open with a warning. To run it locally:

- **Finder:** right-click the app → **Open** → **Open** in the dialog, **or**
- **Terminal:** clear the quarantine attribute, then open:

  ```bash
  xattr -dr com.apple.quarantine "/path/to/Storage Agent Workbench.app"
  open "/path/to/Storage Agent Workbench.app"
  ```

This is expected for an unsigned local build; it is not a defect.

## Lower-level build (compile/link only, no bundle)

```bash
bash scripts/build-desktop-macos.sh
```

This builds the frontend → sidecar → `cargo check` → `cargo tauri build` (if the
Tauri CLI is installed) or `cargo build --release` as a fallback.

## Step by step

```bash
# 1. Frontend
cd frontend && npm install && npm run build && cd ..

# 2. Sidecar binary -> Tauri externalBin (auto-detects target triple)
python3 scripts/build-sidecar-for-tauri.py

# 3. Verify it compiles + links
bash scripts/verify-desktop-build.sh        # cargo check + cargo build

# 4. (optional) full build via the Tauri CLI
cargo install tauri-cli --locked            # Option A — keeps the repo simple
cd src-tauri && cargo tauri build
```

## externalBin naming rule

Tauri's `externalBin` expects a binary suffixed with the Rust **target triple**:

```
src-tauri/binaries/storage-agent-sidecar-<target-triple>
```

Examples:

| Platform            | Target triple             | File |
|---------------------|---------------------------|------|
| macOS Apple Silicon | `aarch64-apple-darwin`    | `storage-agent-sidecar-aarch64-apple-darwin` |
| macOS Intel         | `x86_64-apple-darwin`     | `storage-agent-sidecar-x86_64-apple-darwin` |

`scripts/build-sidecar-for-tauri.py` detects the triple (via `rustc -Vv`) and
copies the binary automatically. The `binaries/` dir is **gitignored** — the
binary is a build artifact and must not be committed.

## Status / limitations

- **macOS arm64**: builds and links (`cargo check` + `cargo build` verified
  locally and in CI). **`cargo tauri build` verified** with the Tauri CLI
  (2.11.3) installed — it runs the frontend build and produces the optimized
  release binary at `src-tauri/target/release/storage-agent-workbench`. Because
  `bundle.active` is `false`, no `.app` bundle is produced (enable bundle
  targets + provide `.icns` when you want a distributable bundle).
- **macOS x64 / universal**: not built/verified yet (TODO). Build on an Intel
  machine, or set up cross/universal binaries in a later phase.
- **`.app` bundle**: **enabled** (`bundle.active=true`, targets `["app","dmg"]`,
  icons incl. `icon.icns`). `cargo tauri build` produces an unsigned `.app`
  (and a DMG when the bundler can build one). CI uploads these as artifacts.
- **Code signing**: NOT done (no Apple Developer cert) — the bundle is unsigned;
  see "Opening the UNSIGNED app" above.
- **Notarization**: NOT done.
- **Auto-update**: NOT implemented.
- **Sidecar lifecycle**: Tauri spawns the bundled sidecar on a free localhost
  port and kills it on app exit. As a safety net (PyInstaller one-file re-execs
  a child that a parent kill may orphan), the sidecar runs a parent-PID watchdog
  (`STORAGE_AGENT_PARENT_PID`) and exits when the app process disappears — so no
  sidecar is left running after the app quits or crashes.
- **App data dir**: production uses the OS app-data dir (Tauri passes
  `STORAGE_AGENT_DATA_DIR`); dev uses `<repo>/data`. User data is never written
  to the install dir and is never bundled. See `docs/packaging.md`.
- **Secrets**: remain in the OS keychain (`keyring`); never bundled or logged.
- **Vercel SDK**: not used and not part of the desktop architecture.

## Release checklist (manual, Phase 09)

1. `git pull` latest `main`; create a release branch if needed.
2. `pip install -e "./sidecar[dev]" -e "./sidecar[packaging]"`.
3. `cd sidecar && pytest -q` (all green).
4. `bash scripts/build-desktop-macos.sh`.
5. `bash scripts/verify-desktop-build.sh` (confirms artifact).
6. Smoke-test the packaged sidecar: `python sidecar/packaging/smoke_test_sidecar.py`.
7. Launch the app; confirm sidecar status reaches **connected** (first launch
   may show **starting (slow)**).
8. (Future) signing, notarization, auto-update, x64/universal builds.
