# Release

A release is more than a tag. The workflow in `.github/workflows/release.yml`
builds macOS (x64 + arm64), Windows and Linux from the tagged commit; the
Publish job attaches the installers, `latest*.yml` and `sbom.json` to the
GitHub release.

## Gates

1. `npm run typecheck && npm run lint && npm test && npm run build`
2. `npm run budget` (initial renderer JavaScript under 500 KiB)
3. `xvfb-run -a node scripts/e2e.mjs` (real window, axe, fake S3 + model)
4. `xvfb-run -a node scripts/eval.mjs --runs 2` against **two** models, at
   least one large and one small/medium context model. The smoke run only
   checks plumbing; it is not a quality result.
5. `xvfb-run -a node scripts/shots.mjs && node scripts/visual.mjs` (committed
   baselines under `visual/baseline`)
6. The moto compatibility job (S3, IAM, KMS; CloudTrail is reported as
   unavailable when the emulator has no endpoint).

## Signing and notarization

These are release requirements, not CI suggestions:

- macOS: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.
- Windows: `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`.
- A signed build needs the certificate available to the runner; the app cannot
  prove a signature from inside itself.

The release workflow has a `Require code signing` job that fails before build
when any of these secrets is missing. The real-model eval job also runs before
build and its reports become part of the release notes. There is no unsigned
distribution path.

## Update path

Before publishing a major release, install the previous release, let it check
for the new one, download it and restart. The updater is disabled when
`STORAGE_AGENT_NO_UPDATE` is set and only runs in a packaged build. A new
release must keep the three feed names (`latest.yml`, `latest-mac.yml`,
`latest-linux.yml`) and the same `appId`.

## What's new

Settings shows one line for the release. Keep it factual and short; the
`CHANGELOG.md` entry is the full record. There is no in-app modal.
