# Storage Agent Workbench

A local-first desktop agent for object storage on S3-compatible systems —
**operations, analytics, and management**. It diagnoses issues, analyzes access
logs and inventory, reviews account and bucket configuration, triages errors,
profiles usage and cost, and recommends optimizations. Everything runs on your
machine; your data and credentials never leave your computer.

It is **evidence-driven** and **human-in-the-loop**: the agent investigates with
read-only tools, grounds its conclusions in artifacts you collected, and
*proposes* next steps that you review and confirm. It never mutates your storage
and never runs an action on its own.

## Install

Download the installer for your platform from
[GitHub Releases](https://github.com/hxddh/storage-agent-workbench/releases).
Each release also includes `SHA256SUMS-*.txt` so you can verify your download.

| Platform | Asset |
| --- | --- |
| macOS (Apple Silicon) | `…-macos-arm64.dmg` |
| Linux (x64) | `…-linux-x64.deb` |
| Windows (x64) | `…-windows-x64-setup.exe` |

These builds are **ad-hoc signed, not notarized / not Authenticode-signed**, so
each OS warns on first launch. This is expected — here's how to open it.

### macOS — “cannot be opened” / “is damaged”

Because the app isn't notarized, macOS quarantines it after download and may say
either *"Apple cannot check it for malicious software"* or *"is damaged and can't
be opened."* Neither means the app is broken — it's the missing Apple signature.
Pick one:

- **Terminal (most reliable).** After moving the app to `/Applications`, clear the
  quarantine flag and open it:

  ```bash
  xattr -dr com.apple.quarantine "/Applications/Storage Agent Workbench.app"
  open "/Applications/Storage Agent Workbench.app"
  ```

- **Finder.** Right-click the app → **Open** → **Open** in the dialog. (If macOS
  says *"damaged"*, use the Terminal step above — right-click Open won't clear
  that.)

The app starts in a few seconds. You'll see **Sidecar: Connecting** briefly while
the local backend comes up.

> Secrets are kept in an encrypted local vault, so there is **no** system
> keychain authorization prompt on any platform. After updating to a build that
> introduced the vault, re-enter your model API key and cloud credentials once
> (they aren't migrated from the old keychain) — you won't be prompted again.

### Linux

```bash
sudo apt install ./storage-agent-workbench-*-linux-x64.deb
```

A WebKitGTK runtime is required (pulled in as a dependency on most distros).

### Windows

Run `…-windows-x64-setup.exe`. SmartScreen may warn because the installer isn't
signed — choose **More info → Run anyway**. WebView2 is required (preinstalled on
current Windows; the installer fetches it if missing).

## What it does

1. Configure a model provider and an S3-compatible cloud provider.
2. Discover the account and its buckets.
3. Review bucket configuration — security, lifecycle, observability, cost.
4. Import evidence (inventory / access logs) with explicit confirmation.
5. Analyze inventory and access logs locally with DuckDB.
6. Triage S3 / object-storage errors.
7. Keep the investigation in a **session** (rename / pin / archive / delete /
   fork / search) and generate Markdown reports.

The interface is a thread-first agentic workbench: a session rail, a conversation
thread where runs and findings render as inline cards, and a settings drawer.
Dark and light themes; English and 中文.

## Safety model

- **Local-first.** App data lives in the OS app-data directory; nothing is sent
  anywhere except the cloud/model providers you configure.
- **Secrets in an encrypted local vault.** Access keys, secret keys, session
  tokens, and model API keys live only in an AES-256-GCM vault on your device
  (key protected per-OS) — never in SQLite, logs, reports, or model prompts.
- **Read-only.** No destructive or mutating S3 operations; no generic shell or
  arbitrary subprocess tool. The agent investigates with read-only tools and can
  run read-only checks itself.
- **You confirm anything that moves data.** Downloads, large scans, and dataset
  analysis always wait for your confirmation; there is no write tool. (An
  autonomy setting controls whether the agent auto-runs *read-only* checks or
  proposes them.)
- Agent context is bounded and sanitized; chain-of-thought is never persisted.

See [docs/security.md](docs/security.md) for the full model.

## Documentation

- [docs/install.md](docs/install.md) — installing per platform.
- [docs/product.md](docs/product.md) — product shape and core jobs.
- [docs/architecture.md](docs/architecture.md) — how the pieces fit together.
- [docs/security.md](docs/security.md) — secret handling and safety rules.
- [docs/signing.md](docs/signing.md) — macOS signing/notarization status.
- [docs/release.md](docs/release.md) — release flow and platform support.
- [CHANGELOG.md](CHANGELOG.md) — release notes.

## License

[Apache License 2.0](LICENSE). You may use, modify, and distribute this software,
including commercially, provided you preserve the copyright and `NOTICE`
attribution; the license also includes an explicit patent grant.
