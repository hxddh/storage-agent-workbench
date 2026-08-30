# Release

How Storage Agent desktop builds are validated and published.

## Release contract

A formal release is cut only from a **green `main` commit**. The immutable source
commit is exposed through a `release/vX.Y.Z` branch; pushing that branch triggers
`.github/workflows/release.yml` automatically.

The workflow is transactional:

1. Resolve `vX.Y.Z` and the exact branch SHA.
2. Create a **hidden Draft GitHub Release** targeted at that exact SHA.
3. Build macOS arm64, Linux x64, and Windows x64 independently.
4. Upload every required installer plus a platform-specific `SHA256SUMS` file.
5. Publish the Release only after all required platform jobs succeed.

A failed platform build therefore cannot produce a partially public release.
Builds are ad-hoc/unsigned (no Apple notarization and no Windows Authenticode);
see [signing.md](signing.md).

## Required pre-release gates

The exact candidate head and the eventual squash/merge commit on `main` must both
pass the repository CI matrix:

- frontend typecheck, lint, unit/architecture tests and production build;
- real-Sidecar Playwright E2E;
- Agent visual-review screenshot capture;
- Sidecar Ruff/import/tests;
- packaged Sidecar smoke;
- macOS Apple Silicon desktop build/runtime verification;
- Linux x64 desktop build/runtime verification;
- Windows x64 desktop build/runtime verification.

No cloud credentials, model credentials, signing identities or GUI secrets are
required by these gates.

## Triggering a release

After the exact `main` commit is green, create the immutable release branch at
that commit:

```bash
git fetch origin main
git branch release/v0.93.0 <VERIFIED_MAIN_SHA>
git push origin release/v0.93.0
```

The branch push is the preferred release trigger because the workflow derives
both the version and exact source SHA from GitHub itself. `workflow_dispatch`
remains available for maintenance, but normal releases do not require a manually
created tag or a separate dispatch step.

The Release workflow creates the `vX.Y.Z` tag automatically when the hidden
Release is created and targets the immutable release-branch SHA.

## Version stamping

Each platform job runs `scripts/stamp-version.py` with the release version before
building. It updates the build-time version metadata for Tauri, Cargo, Sidecar and
frontend packages without requiring a version-only source commit before release.

## Platform artifacts

Stable public asset names use the product identity **Storage Agent**:

| Platform | Required asset |
| --- | --- |
| macOS arm64 | `storage-agent-vX.Y.Z-macos-arm64.app.zip` |
| macOS arm64 | `storage-agent-vX.Y.Z-macos-arm64.dmg` when DMG generation succeeds |
| Linux x64 | `storage-agent-vX.Y.Z-linux-x64.deb` |
| Windows x64 | `storage-agent-vX.Y.Z-windows-x64-setup.exe` |

Every platform also uploads one checksum manifest:

- `SHA256SUMS-macos-arm64.txt`
- `SHA256SUMS-linux-x64.txt`
- `SHA256SUMS-windows-x64.txt`

The historical repository, Rust crate and main executable may retain
`storage-agent-workbench` as a technical compatibility identifier. Public product
and Release asset names must not use it.

## macOS sealing

`cargo tauri build` with no signing identity leaves an invalid resource seal, and
Tauri's hardened-runtime signing prevents the bundled PyInstaller Sidecar from
loading its embedded framework. The default release therefore runs
`scripts/sign-macos-app-bundle.sh`, which deep ad-hoc signs **Storage Agent.app**
without hardened runtime, verifies the seal, and rebuilds the DMG from the sealed
app. It is still not notarized.

## Runtime verification

`scripts/verify-runtime-{macos.sh,linux.sh,windows.ps1}` (over
`verify-runtime-common.py`) verify the built app/technical executable, bundled
Sidecar `/health`, launch lifecycle where supported, and data-directory safety.
Technical binary names are deliberately independent of the public product name.

## Release checklist

1. Freeze the candidate head; no speculative changes after this point.
2. Require exact-head PR CI to be fully green.
3. Review the `agent-visual-review` artifact for real-state Agent UI coverage.
4. Merge with an expected-head SHA guard.
5. Require the exact `main` merge SHA CI to be fully green.
6. Create `release/vX.Y.Z` at that exact verified SHA.
7. Require Prepare + macOS + Linux + Windows + Publish Release jobs to succeed.
8. Verify the final GitHub Release is `draft=false`, `prerelease=false`, and its
   tag resolves to the verified `main` SHA.
9. Verify all required assets are non-empty and all three `SHA256SUMS` manifests
   are present.
10. Smoke-test the downloaded desktop build when a local platform is available;
    see [release-smoke-test.md](release-smoke-test.md).
