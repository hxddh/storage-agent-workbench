# Storage Agent vX.Y.Z

> Release notes describe **what changed in this release**. They are historical snapshots after publication, not the canonical architecture specification. Current contributors should start at [`docs/README.md`](README.md), [`product.md`](product.md), and [`architecture.md`](architecture.md).
>
> The Release workflow normally generates the published notes from the matching `CHANGELOG.md` release entry and appends the standard install/download block. Use this file as the content contract for a manual/draft release or when reviewing generated notes.

## Summary

One short paragraph describing the user-visible outcome of the release. State what became better or newly possible; do not lead with internal refactors.

## Highlights

- **Agent Task / product behavior:** describe only real shipped behavior.
- **Storage capability:** new or materially improved diagnostics, evidence, analysis, or provider support.
- **Trust / reliability:** safety, persistence, execution truth, recovery, or quality improvements.

Delete categories that do not apply.

## Product architecture note

If the release changes the product model or ownership boundaries, describe the new current contract precisely and ensure the canonical docs + executable architecture/documentation tests changed in the same PR.

Do **not** describe aspirational multi-agent workers, plans, terminal/browser control, storage mutation, or other capability the runtime does not actually implement.

For releases that preserve the v0.93 model, a concise statement is enough:

> Storage Agent remains organized around durable Agent Tasks: Direction → real Execution → Decision when required → Work Result → reviewable Artifacts, with one Delegate/Steer/Stop control path.

## Download

Choose the asset for your platform from the GitHub Release.

| Platform | Asset pattern | Distribution status |
| --- | --- | --- |
| macOS Apple Silicon | `storage-agent-vX.Y.Z-macos-arm64.dmg` / `.app.zip` | ad-hoc signed, not notarized |
| Linux x64 | `storage-agent-vX.Y.Z-linux-x64.deb` | unsigned package |
| Windows x64 | `storage-agent-vX.Y.Z-windows-x64-setup.exe` | not Authenticode-signed |

Every platform release also includes its platform-specific SHA256 manifest.

## Install

See [`install.md`](install.md).

Current distribution caveats:

- macOS may require Finder **Right-click → Open** or clearing the quarantine attribute for trusted downloaded builds;
- Windows SmartScreen may warn because the installer is not Authenticode-signed;
- Linux installs through the normal `.deb` package flow and requires the platform webview runtime dependencies.

## Security model

Summarize only security behavior changed by the release. The baseline remains:

- local-first application/data model;
- cloud/model secrets in the encrypted local vault;
- no secret values in model prompts or durable execution/evidence records;
- typed, bounded, read-only storage capabilities;
- no generic shell/arbitrary subprocess/destructive storage tool;
- explicit Decision before confirmation-gated cloud data movement;
- bounded/sanitized model and Tool context;
- no chain-of-thought persistence/exposure.

See [`security.md`](security.md) for the canonical contract.

## Known limitations

List only factual current limitations, for example:

- no Apple notarization / Windows Authenticode / trusted auto-update chain;
- macOS x64/universal not produced;
- provider/evidence formats not yet implemented;
- release-specific known issues.

Do not copy forward a limitation after it has been fixed.

## Checksums

Expected checksum manifests:

```text
SHA256SUMS-macos-arm64.txt
SHA256SUMS-linux-x64.txt
SHA256SUMS-windows-x64.txt
```

Example verification:

```bash
shasum -a 256 -c SHA256SUMS-macos-arm64.txt
sha256sum -c SHA256SUMS-linux-x64.txt
```

Use the platform-appropriate checksum tool on Windows.

## Verification performed

Record what actually ran for this exact release source SHA:

- CI status and source SHA;
- frontend unit/architecture/documentation gates;
- Sidecar tests/package smoke;
- real-Sidecar E2E;
- Agent visual-review artifact review;
- desktop build/runtime checks for each required platform;
- manual smoke platforms actually tested.

Never write “all tests passed” unless that exact candidate was checked.

## Full changes

Link to the matching `CHANGELOG.md` section and compare range for this release.
