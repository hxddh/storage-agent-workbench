# Install

Download the installer for your platform from
[GitHub Releases](https://github.com/hxddh/storage-agent-workbench/releases).
Each release attaches macOS, Linux, and Windows assets plus per-platform
`SHA256SUMS` files you can use to verify your download.

Builds are **ad-hoc signed and not notarized**, so every platform shows some form
of "unidentified developer" warning on first launch. This is expected for these
pre-1.0 builds; it is not a defect. Cold start takes a few seconds while the
bundled sidecar comes up — the window shows **Sidecar: Connecting** until it is
ready.

## macOS (Apple Silicon)

1. Download `...-macos-arm64.dmg` (or `...-macos-arm64.app.zip`).
2. From the DMG, drag **Storage Agent Workbench** to `/Applications`; from the
   zip, unzip and move the app there.
3. Open it one of two ways:
   - **Finder:** right-click the app → **Open** → **Open** in the dialog; or
   - **Terminal:** clear the quarantine attribute, then open:

     ```bash
     xattr -dr com.apple.quarantine "/Applications/Storage Agent Workbench.app"
     open "/Applications/Storage Agent Workbench.app"
     ```

The app is ad-hoc code-signed, so the bundle seal is valid (no "app is damaged"
error). It is not a Developer ID signature and not notarized, so the Gatekeeper
prompt is expected. See [signing.md](signing.md).

## Linux (x64)

```bash
sudo apt install ./storage-agent-workbench-*-linux-x64.deb
```

Or download the `.deb` and install via your package manager. A WebKitGTK runtime
is required (pulled in as a dependency on most distributions).

## Windows (x64)

Run `...-windows-x64-setup.exe`. SmartScreen may warn because the installer is
not Authenticode-signed — choose **More info → Run anyway**. The WebView2 runtime
is required (preinstalled on current Windows; the installer fetches it if absent).

## Data and secrets

- **App data** (SQLite DB, DuckDB files, reports, uploads) is stored in the OS
  app-data directory; in dev it lives under `<repo>/data`.
- **Secrets** (cloud access/secret keys, session tokens, model API keys) are
  stored only in the **OS keychain / keyring** — never in plaintext on disk.
- User data is **never** written into the install directory or bundled into the
  app.

See [security.md](security.md) and [packaging.md](packaging.md) for details.

## macOS keychain prompts

The first time the app reads a stored secret (e.g. your model API key) you may
see a macOS dialog: *"storage-agent-sidecar wants to use your confidential
information…"*. Click **Always Allow** — the app then reads that secret without
prompting again.

If you are re-prompted on later launches, it is because the build is **ad-hoc
signed**: each new version is a different code identity, so macOS asks again
after an update (and after a reinstall). The app reads each secret at most once
per launch, so you will see at most one prompt per secret. A future
Developer-ID-signed/notarized build would remove the re-prompting entirely
(see [signing.md](signing.md)).
