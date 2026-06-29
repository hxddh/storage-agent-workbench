# Storage Agent Workbench vX.Y.Z

> Copy this template into the GitHub Release notes when publishing a release.
> Fill each section; delete guidance lines before publishing.

## Highlights

A few bullet points on what is new or notable in this release.

## Download

Pick the asset for your platform from the Release assets below. macOS arm64 is
the primary supported target; other platforms are experimental.

## Supported platforms

- macOS arm64 — supported (unsigned).
- Linux x64 — experimental (asset attached only when produced).
- Windows x64 — experimental (asset attached only when produced).

## Install

See [docs/install.md](install.md). The build is unsigned; expect a Gatekeeper
warning on macOS and use right-click → Open or clear the quarantine attribute.

## Security model

Local-first; secrets in an encrypted local vault (no system prompts); read-only
diagnostics and no write/destructive S3 operations; data-moving actions always
require confirmation; sanitized agent context. See
[docs/security.md](security.md).

## Known limitations

- No code signing / notarization / auto-update.
- macOS x64 / universal not built.
- Linux / Windows experimental.
- (List any release-specific gaps here.)

## Checksums

See `SHA256SUMS.txt` attached to this Release.

## Verification

```bash
shasum -a 256 -c SHA256SUMS.txt
```

## Development notes

Link to the relevant CHANGELOG.md section and any notable context for this release.
