# Release

> **Current process baseline: Storage Agent v1.10.0.**
>
> A release is a build of one exact verified source SHA. Release notes become historical records after publication; they do not override the current architecture contracts in `docs/README.md`, `product.md`, `architecture.md`, or `CLAUDE.md`.

## Release contract

A formal release is cut only from a **green `main` commit**. The intended immutable source commit is exposed through a `release/vX.Y.Z` branch; the release workflow resolves that branch/version and targets the exact SHA.

The publication flow is transactional:

1. resolve `vX.Y.Z` and the exact release-branch SHA;
2. create/prepare a hidden Draft GitHub Release targeted at that SHA;
3. build macOS Apple Silicon, Linux x64, and Windows x64 independently;
4. upload required installers plus platform-specific SHA256 manifests;
5. publish only after every required platform job succeeds.

A failed platform job must not leave a partially public release.

Current distribution is ad-hoc/unsigned in the trust-store sense: macOS is ad-hoc signed but not notarized; Windows is not Authenticode-signed. See [`signing.md`](signing.md).

## Required candidate gates

The exact candidate source and final `main` release source must pass the repository's required checks, including the gates applicable to that commit:

- frontend TypeScript typecheck/lint;
- Vitest unit tests, including Agent architecture/legacy/documentation contracts;
- frontend production build;
- Python Sidecar lint/import/tests;
- packaged Sidecar smoke;
- real-Sidecar Playwright E2E;
- Agent real-state visual-review capture;
- macOS Apple Silicon desktop build/runtime verification;
- Linux x64 desktop build/runtime verification;
- Windows x64 desktop build/runtime verification.

The required CI path must not depend on production model/cloud credentials or private signing identities.

## Product gate

A green build is not sufficient if the packaged frontend regresses to an older product model.

For every release candidate, `release-smoke-test.md` is the product acceptance contract. At minimum verify that the candidate preserves:

- Agent Task as the primary application object;
- one Delegate / Steer / Stop control path;
- real Execution rather than synthetic Agent chrome;
- durable Work Results;
- explicit Decision required state for gated work;
- contextual Evidence / Execution / Report Review;
- real per-task in-flight state across task switching;
- current safety/secret boundaries.

## Creating the release branch

After the exact `main` commit is green:

```bash
git fetch origin main
git branch release/vX.Y.Z <VERIFIED_MAIN_SHA>
git push origin release/vX.Y.Z
```

The release branch name is the version source for the normal automated release path. `workflow_dispatch` may remain available for maintenance, but the ordinary flow should not require a separate manually invented source SHA.

The workflow creates/targets the matching `vX.Y.Z` release/tag according to `.github/workflows/release.yml` and must keep it tied to the verified source commit.

## Version stamping

Platform jobs run the repository's version-stamping script before build so Tauri/Cargo/Sidecar/frontend package metadata reflects the release version without requiring a version-only source commit.

The GitHub tag and public asset names keep the release-branch spelling (`v1.10.0`). Bundle metadata is canonical semver (`1.4.0`): leading zeros in numeric components are stripped because Tauri and Cargo reject `1.02.0`.

Do not treat the frontend development package version as the authoritative public release version when the release workflow stamps it from the release branch/tag.

## Public product identity and artifacts

Public product identity is **Storage Agent**.

Expected release assets:

| Platform | Required public asset |
| --- | --- |
| macOS Apple Silicon | `storage-agent-vX.Y.Z-macos-arm64.app.zip` |
| macOS Apple Silicon | `storage-agent-vX.Y.Z-macos-arm64.dmg` when DMG generation succeeds/is required by the workflow |
| Linux x64 | `storage-agent-vX.Y.Z-linux-x64.deb` |
| Windows x64 | `storage-agent-vX.Y.Z-windows-x64-setup.exe` |

Expected checksum manifests:

```text
SHA256SUMS-macos-arm64.txt
SHA256SUMS-linux-x64.txt
SHA256SUMS-windows-x64.txt
```

Historical repository/crate/binary identifiers may retain `storage-agent-workbench` where migration/technical compatibility requires it. Do not leak that historical technical identifier back into public product naming without an explicit naming change.

## macOS build/sealing

The default release path produces an ad-hoc signed, non-notarized app. The repository sealing step must leave a valid bundle that can launch the embedded PyInstaller Sidecar.

A future Developer ID + notarization path has different hardened-runtime/entitlement requirements. Follow `signing.md`; never ad-hoc re-sign an already Developer ID-signed release.

## Runtime verification

Platform verification scripts under `scripts/` validate the final desktop runtime, including bundled Sidecar health/lifecycle and data-directory safety where supported.

These checks validate packaging/runtime mechanics. The Agent Task product model is validated separately by current frontend contracts, real-Sidecar E2E, visual review, and release smoke.

## Release notes

The matching CHANGELOG/release note should describe the user-visible changes for that version and use the product vocabulary current **at the release being described**.

After publication it is historical. Do not later rewrite historical release behavior to pretend it always matched the newest architecture.

For manual/draft notes use [`release-template.md`](release-template.md).

## Release checklist

1. Freeze the candidate source SHA.
2. Confirm current canonical docs and executable architecture/documentation contracts match the candidate.
3. Require exact-head CI to be green.
4. Review the real-state Agent visual artifact.
5. Merge/update `main` with the intended expected-head guard/process.
6. Require the exact release `main` SHA to be green.
7. Create `release/vX.Y.Z` at that exact SHA.
8. Require all release workflow platform/preparation/publication jobs to succeed.
9. Verify the final Release tag resolves to the intended source SHA.
10. Verify required assets are non-empty and checksum manifests are present.
11. Verify checksums from downloaded assets.
12. Run the relevant manual product smoke from [`release-smoke-test.md`](release-smoke-test.md) on available target platforms.
13. Record anything not manually tested instead of claiming it passed.

## Post-release documentation rule

When a release changes architecture, API, persistence, safety, tools, packaging, or roadmap status, the matching canonical documents must already be updated in the release source. Do not postpone those updates to a later “docs cleanup” release: stale docs are an architecture-regression vector for future coding Agents and contributors.
