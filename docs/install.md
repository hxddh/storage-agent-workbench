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

The app is ad-hoc code-signed but **not notarized**, so macOS may say either
*"Apple cannot check it for malicious software"* or *"is damaged and can't be
opened."* Both just mean the missing Apple signature — the **Terminal** step
above (clearing the quarantine flag) reliably resolves either; right-click →
Open only handles the first. See [signing.md](signing.md).

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
  stored only in an **encrypted local vault** (`secrets.enc`) in the app-data
  directory — never in plaintext on disk, SQLite, logs, reports, or model
  prompts. The vault's master key is protected per-OS by a non-prompting
  mechanism (Windows DPAPI; an owner-only `0600` key file on macOS/Linux).
- User data is **never** written into the install directory or bundled into the
  app.

See [security.md](security.md) and [packaging.md](packaging.md) for details.

## Secret storage: no authorization prompts

Secrets live in the encrypted local vault described above, so there is **no**
system keychain/secret-service authorization prompt on macOS, Windows, or Linux.

The vault is not migrated from the old OS-keychain storage used by builds before
the vault landed (reading those would have triggered the very prompt we removed),
so the first time you run a vault build, **re-enter your model API key and cloud
credentials once** in Settings → Providers. They are never prompted for again.
(On macOS/Linux the key file sits beside the vault with owner-only permissions —
the standard local-first tradeoff; a future Developer-ID-signed build could
re-enable the macOS keychain prompt-free, see [signing.md](signing.md).)
