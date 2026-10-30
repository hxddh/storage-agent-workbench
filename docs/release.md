# Release

A release is a tag, three platform builds and one GitHub release. The
workflow is `.github/workflows/release.yml`; a `v*` tag starts it, or a manual
dispatch with an existing tag.

## CI

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests:

- **check**: typecheck, Biome lint, Vitest, build, bundle budget,
  secondary-text contrast, production dependency audit and SBOM;
- **e2e**: the real-window E2E with fake S3 and a fake model, the no-model
  first-run E2E, the eval smoke, the bench smoke, cold-start performance,
  screenshots and the visual comparison (captures are uploaded when it
  fails);
- **bench-real**, on pushes to `main` only: `bench.mjs --runs 3` for a small
  model (`EVAL_MODEL_SECONDARY`) and a large one (`EVAL_MODEL_PRIMARY`). Without
  `EVAL_API_KEY` or the model variable the job says it did not run and passes;
- **compat**: the moto compatibility suite.

`.github/workflows/eval.yml` is a manual run of `eval.mjs` against a provider,
model, base URL, reasoning level and run count given as inputs.

The Release workflow does not run typecheck, lint or unit tests. Tag a commit
from a green `main`.

## Release jobs

1. **Evaluation.** With the `EVAL_API_KEY` secret, `eval.mjs --runs 2` for the
   primary and secondary model, then `bench.mjs --runs 3` for the primary and,
   when `EVAL_MODEL_SECONDARY` is set, the secondary. Without it,
   `eval.mjs --smoke` and `bench.mjs --smoke`. The eval scores the agent's
   answer against the fake storage's known truth; the bench scores the
   conversation (calls, citations, clarify, steer, resume, follow-ups, a
   change written for the user, model choice) and what it said.
2. **Signing detection.** Checks the seven signing secrets; only when every
   one is present is the build marked signed.
3. **Build.** macOS (`.dmg`, `.zip`, x64 and arm64), Windows (NSIS `.exe`) and
   Linux (AppImage, `.deb`), with `sbom.json`, the `latest*.yml` feeds and
   blockmaps. Builds run in parallel; if any fails, nothing is published.
4. **Publish.** Collects every artifact, writes release notes from the eval
   and signing facts, and creates one GitHub release. The notes are headed either
   "Real-model evaluation" or "Evaluation: harness smoke only", and end with
   either "Installers are signed and notarized." or "These installers are
   unsigned. macOS builds are ad-hoc signed only; …".

## Signing

- macOS: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.
- Windows: `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`.

With every secret, macOS is signed and notarized and Windows is signed. With
any missing, every platform still builds: macOS is ad-hoc signed by
`scripts/after-sign.cjs` (so an Apple-silicon download can launch) and Windows
is unsigned. The release notes say which. This is a distribution limit, not a
runtime security boundary ([security.md](security.md)).

## Evaluation gates

Real-model evaluation needs a provider key and model variables; without them
the release records a smoke result. The bench gate is every must-pass check
in every run and at least 90% of soft checks; the smoke bench uses the same
gate. Reports are attached and name the model, never the key. A smoke report
is labelled as plumbing only.

For an open-model baseline, point the eval at Ollama. The local server ignores
the key, but the client needs a non-empty one:

```bash
EVAL_PROVIDER=compatible \
EVAL_MODEL=qwen2.5:3b \
EVAL_BASE_URL=http://127.0.0.1:11434/v1 \
EVAL_API_KEY=ollama \
xvfb-run -a node scripts/eval.mjs --runs 1
```

The visual gate compares the captures to `visual/baseline` with a 5% global
budget and a 64px tile check. It is evidence of rendered states, not a
substitute for the E2E interaction checks.

## Update path

`electron-updater` checks this repository's GitHub releases in packaged
builds. A release keeps:

- the `appId` `com.storageagent.app`;
- `latest.yml`, `latest-mac.yml` and `latest-linux.yml`;
- the artifact name `storage-agent-${version}-${os}-${arch}.${ext}`.

A missing feed shows in Settings as an unavailable update source. Before
publishing a packaging or updater change, install the previous release and let
it check, download and restart; there is no automated upgrade test.

## Version

The version is the `package.json` version, **40.0.0**, and the tag is
`v<version>`. Published tags are immutable; a correction is a new patch
release. Settings shows the installed version and the update state. Keep
`README.md` and `docs/screenshot.png` in step with the surface when tagging.
