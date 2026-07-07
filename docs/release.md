# Release

How desktop builds are produced and published.

## TL;DR

Releases are cut by **manually dispatching** the `Release` workflow against a
tag. Each run builds the desktop app for macOS (arm64), Linux (x64), and Windows
(x64) and uploads the installers — plus per-platform `SHA256SUMS` — to one GitHub
Release. Builds are unsigned/ad-hoc (no Apple notarization, no Windows
Authenticode); see [signing.md](signing.md).

```bash
# from an up-to-date main
git tag v0.23.0 && git push origin v0.23.0
gh workflow run release.yml \
  -f version=v0.23.0 -f ref=v0.23.0 -f prerelease=false -f draft=false
```

The bundle version is stamped from the tag by `scripts/stamp-version.py`
(writes `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`,
`src-tauri/Cargo.lock`, `sidecar/pyproject.toml`, and `frontend/package.json`),
so the app and sidecar report the release version rather than a hardcoded one.

## Local builds

One command per platform (frontend → PyInstaller one-dir sidecar → staged as a
Tauri resource → `cargo tauri build` → macOS ad-hoc seal):

```bash
scripts/build-desktop-macos.sh      # macOS arm64: .app + .dmg
scripts/build-desktop-linux.sh      # Linux x64: .deb
scripts/build-desktop-windows.ps1   # Windows x64: NSIS .exe
```

The sidecar is built **on each platform** (PyInstaller does not reliably
cross-compile). It is a one-dir bundle staged at
`src-tauri/sidecar-dist/storage-agent-sidecar/` and bundled via
`tauri.conf.json` → `bundle.resources`. See [packaging.md](packaging.md).

## macOS sealing

`cargo tauri build` with no signing identity leaves an invalid seal (Finder
reports "damaged"), and Tauri's own signing applies the hardened runtime, under
which the PyInstaller sidecar can't load its libraries. So
`scripts/sign-macos-app-bundle.sh` deep ad-hoc signs the bundle **without** the
hardened runtime, verifies `codesign --verify --deep --strict`, and rebuilds the
DMG from the sealed app. See [signing.md](signing.md).

## CI

`.github/workflows/release.yml` has a `prepare` job plus three platform build
jobs:

| Platform | Asset |
| --- | --- |
| macOS arm64 | `...-macos-arm64.dmg` (+ `.app.zip`) |
| Linux x64 | `...-linux-x64.deb` |
| Windows x64 | `...-windows-x64-setup.exe` |

Each job stamps the version from the tag, builds the platform's one-dir sidecar,
builds the Tauri bundle, and uploads stable-named assets with a per-platform
`SHA256SUMS`. A separate CI workflow runs the frontend build, sidecar tests, and
a gating macOS desktop build on every push/PR (Linux/Windows desktop builds and
sidecar packaging run informationally with `continue-on-error`).

## Runtime verification

`scripts/verify-runtime-{macos.sh,linux.sh,windows.ps1}` (over
`verify-runtime-common.py`) confirm the built app launches, spawns the bundled
sidecar, serves `/health`, and cleans up on quit.

## Checklist

1. `main` is green (frontend build + sidecar tests).
2. Bump the version: `python scripts/stamp-version.py X.Y.Z`, commit.
3. Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`.
4. Dispatch the Release workflow (command above).
5. Verify the Release has all three installers + `SHA256SUMS`.
6. Smoke-test at least the macOS build ([release-smoke-test.md](release-smoke-test.md)).
