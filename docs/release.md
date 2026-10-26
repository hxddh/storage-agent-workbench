# Release

A release is a tag plus three platform builds and one GitHub release. The
workflow is `.github/workflows/release.yml`; it is triggered by a `v*` tag or a
manual dispatch with an existing tag.

## What CI checks

The normal CI workflow runs on `main` and pull requests:

- typecheck, Biome lint, Vitest, build, bundle budget, production dependency
  audit and SBOM;
- the real-window E2E with fake S3 and a fake OpenAI-compatible model;
- the no-model first-run E2E;
- the smoke eval, cold-start budget, screenshots and visual comparison;
- the moto compatibility suite.

The Release workflow itself does not run typecheck, lint or unit tests. Tag a
commit from a green `main`; do not use the tag workflow as a substitute for CI.

## Release jobs

1. **Evaluation** — if the `EVAL_API_KEY` secret exists, the job runs
   `scripts/eval.mjs --runs 2` for the primary and secondary model variables and
   retains both reports. If it does not exist, it runs
   `scripts/eval.mjs --smoke` and retains the smoke report. A smoke report
   proves the harness runs; it is not a model-quality score.
2. **Signing detection** — checks all seven signing secrets. Only when every one
   is present is the build marked signed.
3. **Build** — macOS x64 and arm64 (`.dmg`, `.zip`), Windows NSIS `.exe`, Linux
   AppImage and `.deb`, plus `sbom.json` and `latest*.yml` feeds. Builds run in
   parallel; one failed platform stops the publish job.
4. **Publish** — collects all artifacts, writes release notes from the eval and
   signing facts, and creates one GitHub release. The notes explicitly say
   either “real-model evaluation” or “harness smoke only”, and either “signed
   and notarized” or “unsigned; macOS is ad-hoc signed only”.

## Signing

- macOS: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.
- Windows: `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`.

When every secret exists, macOS is signed and notarized and Windows is signed.
When any is absent, the workflow still builds every platform: macOS is ad-hoc
signed (so an Apple-silicon download can launch) and Windows is unsigned. The
release notes state this. There is no silent “unsigned presented as signed”
path.

This is a distribution limitation, not a runtime security boundary. The
application itself still has the read-only, scope and secret boundaries in
[security.md](security.md).

## Evaluation and visual gates

Real-model evaluation is valuable but not guaranteed by the repository alone:
it needs a provider key and model variables. The release records a smoke result
when they are absent. A full run covers 28 scenarios and fails on a must-pass
regression; the report is attached and named after the model, never the key.

For an open-model baseline, point the same eval at Ollama. The local server
ignores the API key; set `OLLAMA_API_KEY` to any non-empty value for the client:

```bash
EVAL_PROVIDER=compatible \
EVAL_MODEL=qwen2.5:3b \
EVAL_BASE_URL=http://127.0.0.1:11434/v1 \
EVAL_API_KEY="$OLLAMA_API_KEY" \
xvfb-run -a node scripts/eval.mjs --runs 1
```

The visual gate in CI compares committed captures to `visual/baseline` with a
5% global budget plus a 64px local-region check. A screenshot run is evidence of
rendered states; it is not a substitute for the E2E interaction checks.

## Update path

`electron-updater` checks this repository's GitHub releases in packaged builds.
A release must keep:

- the same `appId` (`com.storageagent.app`);
- `latest.yml`, `latest-mac.yml` and `latest-linux.yml`;
- the existing artifact naming convention in `package.json`.

A missing feed is shown in Settings as an unavailable update source instead of
failing silently. Before publishing a packaging or updater change, install the
previous release, let it check, download and restart. That upgrade is a manual
check; there is no automated upgrade E2E.

## Release notes and version

Version is the `package.json` version and the tag is `v<version>`. Published
tags are immutable; put a correction in a new patch release. The Settings sheet
shows the installed version and the update state. The full release record lives
in `CHANGELOG.md` and on the GitHub release.

## Current release facts

The latest release is **27.0.0**. Earlier release notes may describe retired
behavior; they are history. Keep `README.md`, `CHANGELOG.md` and this paragraph
in step with the next tag, and refresh `docs/screenshot.png` if the surface
changed. 27.0 changes the task surface from a fixed brief to an agent run with
a plan and report blocks; its visual baselines and E2E cover that surface.
