# Storage Agent Workbench vX.Y.Z

> The `Release` workflow (`.github/workflows/release.yml`) **auto-generates** the
> published notes: the "What's changed" section is pulled from this version's
> `CHANGELOG.md` entry and a standard install block is appended. You normally
> don't hand-write release notes — keep the CHANGELOG entry good and the workflow
> does the rest. This template is a reference for a manual or draft release.
>
> Fill each section; delete guidance lines before publishing.

## Highlights

A few bullet points on what is new or notable in this release (mirrors the
CHANGELOG entry).

## Download

Pick the asset for your platform from the Release assets below. All three
platforms are built and attached on every release.

## Platforms

- macOS arm64 — `…-macos-arm64.dmg` (+ `…-macos-arm64.app.zip`); ad-hoc signed,
  **not notarized**.
- Linux x64 — `…-linux-x64.deb`; unsigned.
- Windows x64 — `…-windows-x64-setup.exe`; unsigned (not Authenticode-signed).

Every OS shows a first-launch warning because the builds are unsigned / not
notarized — this is expected. See [signing.md](signing.md).

## Install

See [docs/install.md](install.md). On macOS use right-click → Open or clear the
quarantine attribute; on Windows choose **More info → Run anyway**; on Linux
`sudo apt install ./…-linux-x64.deb`.

## Security model

Local-first; secrets in an encrypted local vault (no system prompts); read-only
diagnostics and no write/destructive S3 operations; data-moving actions always
require confirmation; sanitized agent context. See [docs/security.md](security.md).

## Known limitations

- No code signing / notarization / auto-update.
- macOS x64 / universal not built (arm64 only).
- (List any release-specific gaps here.)

## Checksums

Each platform ships its own checksum file: `SHA256SUMS-macos-arm64.txt`,
`SHA256SUMS-linux-x64.txt`, `SHA256SUMS-windows-x64.txt`, attached to the Release.

## Verification

```bash
# from the directory holding the downloaded asset + its SHA256SUMS file
shasum -a 256 -c SHA256SUMS-macos-arm64.txt      # macOS
sha256sum -c SHA256SUMS-linux-x64.txt            # Linux
```

## Development notes

Link to the relevant CHANGELOG.md section and any notable context for this release.
