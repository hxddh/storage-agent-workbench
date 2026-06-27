# Install

## Status

- **v0.19.0-pre.1** is the planned first public pre-release.
- Builds are **unsigned** and **pre-1.0** — expect rough edges and Gatekeeper
  warnings.
- **macOS arm64** is the primary supported target.
- Linux x64 and Windows x64 are **experimental** (CI build/smoke only; see below).

Public downloads are published on
[GitHub Releases](https://github.com/hxddh/storage-agent-workbench/releases).
CI artifacts under GitHub Actions are for development verification only and are
not public release assets (see [release.md](release.md)).

## macOS arm64

1. Download the macOS asset from the GitHub Release once it is available
   (`...-macos-arm64.dmg` if present, otherwise `...-macos-arm64.app.zip`).
2. If you downloaded the DMG, open it and drag the app out; if you downloaded the
   zip, unzip it to get `Storage Agent Workbench.app`.
3. Move the app to `/Applications` if you like.
4. **First launch shows a Gatekeeper prompt** ("unidentified developer") because
   the app is ad-hoc signed and not notarized.
5. Open it one of two ways:
   - Finder: right-click the app → **Open** → **Open** in the dialog; or
   - Terminal — clear the quarantine attribute, then open:

     ```bash
     xattr -dr com.apple.quarantine "/path/to/Storage Agent Workbench.app"
     open "/path/to/Storage Agent Workbench.app"
     ```
6. **The first launch is slow (up to ~1 minute).** The app embeds a one-file
   Python sidecar, and macOS validates its code signature the first time it is
   extracted. Subsequent launches are fast. The window shows **Sidecar: Connecting**
   until it is ready.

Notes:

- The app is **ad-hoc code-signed** so the bundle seal is valid (no "app is
  damaged" error). It is **not** signed with an Apple Developer ID and is **not
  notarized**, so the Gatekeeper "unidentified developer" prompt is expected for
  these pre-release builds; it is not a defect.

## Linux x64

Experimental. The CI matrix builds a Linux x64 desktop bundle and runs a sidecar
smoke test, but a public release asset is **not yet supported** for the first
release workflow. Until a `.deb` (or equivalent) is explicitly attached to a
Release, use a local build (`scripts/build-desktop-linux.sh`) or the CI artifact
for development verification only.

## Windows x64

Experimental. The CI matrix builds a Windows x64 NSIS installer and runs a
sidecar smoke test, but a public release asset is **not yet supported** for the
first release workflow. Until an `.exe` is explicitly attached to a Release, use
a local build (`scripts/build-desktop-windows.ps1`) or the CI artifact for
development verification only.

## Data and secrets

- **App data** is stored in the OS app-data directory (the desktop app passes
  `STORAGE_AGENT_DATA_DIR`); in dev it lives under `<repo>/data`.
- **Secrets** (cloud access/secret keys, session tokens, model API keys) are
  stored only in the **OS keychain / keyring** — never in plaintext on disk.
- User data is **never** written into the install directory or bundled into the
  app.

See [security.md](security.md) and [packaging.md](packaging.md) for details.
