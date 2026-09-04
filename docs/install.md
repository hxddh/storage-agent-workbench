# Install

> **Current release baseline: Storage Agent v1.17.2.**
>
> This guide covers the local-first desktop application. Product behavior is documented in [`product.md`](product.md); packaging internals are in [`packaging.md`](packaging.md).

## Download

Download the release asset for your platform from GitHub Releases and verify it with the matching platform-specific `SHA256SUMS` file.

| Platform | Asset pattern |
| --- | --- |
| macOS Apple Silicon | `storage-agent-vX.Y.Z-macos-arm64.dmg` or `.app.zip` |
| Linux x64 | `storage-agent-vX.Y.Z-linux-x64.deb` |
| Windows x64 | `storage-agent-vX.Y.Z-windows-x64-setup.exe` |

Current public builds are not distributed with Apple notarization or Windows Authenticode signing, so first-launch OS warnings are expected. See [`signing.md`](signing.md).

## macOS — Apple Silicon

1. Download the `.dmg` or `.app.zip`.
2. Move **Storage Agent.app** to `/Applications`.
3. Try Finder **Right-click → Open**.
4. If Gatekeeper reports the trusted downloaded app as damaged/unopenable because of quarantine, clear the quarantine attribute and launch it:

```bash
xattr -dr com.apple.quarantine "/Applications/Storage Agent.app"
open "/Applications/Storage Agent.app"
```

The current build is ad-hoc signed but not notarized. Clearing quarantine does not verify provenance by itself: verify the downloaded artifact checksum and use only a release you trust.

## Linux — x64

Install the `.deb` with the system package manager, for example:

```bash
sudo apt install ./storage-agent-*-linux-x64.deb
```

The desktop shell requires the platform WebKitGTK/webview dependencies pulled by the package on supported distributions.

## Windows — x64

Run:

```text
storage-agent-vX.Y.Z-windows-x64-setup.exe
```

Windows SmartScreen may warn because the installer is not Authenticode-signed. Verify the release/checksum before choosing **More info → Run anyway**.

The desktop shell uses WebView2; current Windows installations normally provide it, and the installer/runtime follows the Tauri platform dependency behavior.

## First launch

The Tauri desktop shell starts a bundled local Python Sidecar. A short connecting/starting state is normal while the Sidecar initializes.

The product then presents the current Agent Task experience:

- **Delegate** work through the one Agent input;
- configure model/cloud providers through Settings when needed;
- read-only deterministic/offline storage-error triage remains available for supported errors even without a model provider;
- active work becomes a durable Agent Task with real Execution, Work Results, Decisions when required, and contextual Review.

If the Sidecar cannot start, treat that as a runtime/packaging fault rather than repeatedly creating new Tasks.

## Local data

All user data lives under the OS application-data directory selected by Tauri/Sidecar configuration, never inside the installed app directory.

It can include:

- SQLite application metadata and durable Agent Task records;
- DuckDB analysis files;
- uploaded/imported evidence;
- report artifacts;
- the encrypted secret vault.

In source/development workflows the repository-local data directory may be used according to `packaging.md`/runtime configuration.

## Secrets

Cloud access/secret keys, temporary session tokens, and model API keys are stored only in the encrypted local vault (`secrets.enc` plus its protected master key). SQLite stores opaque `keyring://...` references, not plaintext credentials.

Current master-key protection:

- Windows: current-user DPAPI;
- macOS/Linux: owner-only `0600` key file.

The current product intentionally avoids the system keychain/secret-service flow, so there should be no OS keychain authorization prompt when adding or using provider credentials.

Builds that predate the encrypted-vault storage model are not automatically treated as a source of old keychain secrets; users may need to enter provider credentials again when moving from a sufficiently old build.

See [`security.md`](security.md).

## Sidecar security

The packaged launcher:

- binds the Sidecar to localhost;
- chooses a free local port;
- generates a random per-launch auth token;
- passes the token to the Sidecar;
- gives the URL/token to the webview through Tauri commands;
- shuts the Sidecar down with the desktop app.

Normal API calls use the Sidecar token header; SSE uses the supported token query path. This local token is separate from model/cloud credentials.

## Verify a release

Use the matching checksum manifest from the GitHub Release. Example:

```bash
# macOS
shasum -a 256 -c SHA256SUMS-macos-arm64.txt

# Linux
sha256sum -c SHA256SUMS-linux-x64.txt
```

Use the platform-appropriate SHA256 verification tooling on Windows.

## Troubleshooting boundaries

Installation/runtime issues should be kept distinct from Agent/storage findings:

- **App will not open / OS warning** → distribution/signing/quarantine issue.
- **App opens but Sidecar never connects** → packaged runtime issue.
- **Sidecar connects but provider/model fails** → provider/runtime configuration issue surfaced as Task attention state where applicable.
- **Storage request fails** → delegate the storage problem to the Agent; do not change installation/security settings merely to make an S3 error disappear.
