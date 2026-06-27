# Release (desktop)

Desktop release flow for Storage Agent Workbench. This documents the
**local macOS build flow**, the **CI build artifacts**, the **public GitHub
Releases** channel, and the **manual pre-release workflow**. There is **no** code
signing, notarization, or auto-update yet.

## Distribution channels

Three distinct things — do not confuse them:

1. **Local build** — what you produce on your own machine via the scripts below.
   For development and manual verification.
2. **CI build artifacts** — uploaded by `.github/workflows/ci.yml` on each run
   (under the GitHub Actions run page). They prove the build compiles and the
   sidecar smoke-passes. **They are not public releases**: they require a GitHub
   login to download, they **expire** (artifact retention), and they are not a
   stable download URL.
3. **GitHub Releases** — the **intended public download location**. Releases are
   created by the **manual** `.github/workflows/release.yml` workflow
   (`workflow_dispatch` only) and carry stable, named assets plus
   `SHA256SUMS.txt`.

Current public release target: **macOS arm64, unsigned**. Linux x64 and Windows
x64 remain **experimental** and are only public-release assets if explicitly
attached by a release workflow. No signing, notarization, or auto-update.

### Manual pre-release (after the readiness PR is merged)

The release workflow is dispatch-only and does not run on push/tag. Publish a
pre-release like this (run from a clean, up-to-date `main`):

```bash
git checkout main
git pull --ff-only
git tag v0.19.0-pre.1
git push origin v0.19.0-pre.1
gh workflow run release.yml \
  -f version=v0.19.0-pre.1 -f ref=v0.19.0-pre.1 -f prerelease=true -f draft=true
```

The workflow checks out `ref`, builds the macOS arm64 bundle, computes
`SHA256SUMS.txt`, and creates/updates a (draft, prerelease) GitHub Release named
`version` with the assets attached. Tagging is optional — `ref` may be a branch
or a tag — but tagging the exact commit you release is recommended for
reproducibility. Review the draft Release, then publish it from the GitHub UI.

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

## Platform support matrix (Phase 12)

| Platform | Arch | Build | Bundle artifact | Sidecar smoke | Runtime launch | Cleanup | Signing | Status |
|----------|------|-------|-----------------|---------------|----------------|---------|---------|--------|
| macOS | arm64 | yes | `.app` + DMG | yes | local verified (CI best-effort) | yes | no | **supported (unsigned)** |
| macOS | x64 | no | no | no | no | no | no | out of scope |
| macOS | universal | no | no | no | no | no | no | out of scope |
| Linux | x64 | yes (CI) | `.deb` | yes (CI) | skipped on headless CI (real-desktop pending) | n/a in CI | no | experimental / support candidate |
| Windows | x64 | yes (CI) | NSIS `.exe` | yes (CI) | verified (CI) | verified (CI) | no | experimental / support candidate |

### Runtime verification

`scripts/verify-runtime-common.py` (driven by `verify-runtime-{macos.sh,linux.sh,windows.ps1}`)
checks, per platform: app executable present, bundled sidecar present, a direct
sidecar `/health` smoke, app-data-dir not under the install dir, and a launch
lifecycle (start app → it spawns the bundled sidecar on a free port → `/health`
ok → quit → sidecar cleaned up by the parent-PID watchdog). The first four are
required; the GUI launch is best-effort (hard-gated only with `--require-launch`,
used locally on macOS). On the **headless Linux CI runner the GUI launch is
skipped** (`--skip-launch`) — a real WebKitGTK launch under xvfb is unreliable
(it can hang), so Linux launch-lifecycle is verified on a real desktop, not in
CI. **Windows CI verifies the full launch lifecycle**; **macOS launch is verified
locally** (and best-effort on the CI runner). Artifacts are uploaded **before**
runtime verification so a verification issue never drops the build artifact.

### Linux / Windows promotion criteria (experimental → supported)

To promote a platform from experimental to supported it needs: green CI build +
sidecar smoke + bundle artifact, **and** a verified launch lifecycle (sidecar
spawn + `/health` + clean exit) on that platform — ideally on a real desktop
session, not only the CI/xvfb runner. macOS arm64 meets this (locally verified);
Linux/Windows currently verify build + sidecar smoke + best-effort CI launch.

- **macOS arm64** is the only locally verified, supported target (unsigned).
  macOS x64 / Intel and universal builds are **out of scope** for now.
- **Linux x64** and **Windows x64** are exercised in CI as **experimental**
  jobs (`continue-on-error`): they run frontend + sidecar build + externalBin
  copy + sidecar `/health` smoke test + `cargo check`/`cargo build` +
  `cargo tauri build` (`.deb` / NSIS), and upload artifacts when produced. CI
  does not launch the GUI. Their pass/partial/blocker status is reported
  honestly and does not block merges.

### Cross-platform build commands

```bash
# Linux x64 (on a Linux host with the system deps below)
bash scripts/build-desktop-linux.sh
```

```powershell
# Windows x64 (on a Windows host)
powershell -ExecutionPolicy Bypass -File scripts/build-desktop-windows.ps1
```

`scripts/build-sidecar-for-tauri.py` detects the Rust target triple and copies
the one-file sidecar to the externalBin path:

| Platform | externalBin path |
|----------|------------------|
| macOS arm64 | `src-tauri/binaries/storage-agent-sidecar-aarch64-apple-darwin` |
| Linux x64 | `src-tauri/binaries/storage-agent-sidecar-x86_64-unknown-linux-gnu` |
| Windows x64 | `src-tauri/binaries/storage-agent-sidecar-x86_64-pc-windows-msvc.exe` |

Linux system deps (Tauri v2): `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev
patchelf libayatana-appindicator3-dev build-essential libssl-dev`.

PyInstaller does not reliably cross-compile, so each platform's sidecar must be
built on that platform (the CI matrix does this per-runner).

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
