# Release

A release is more than a tag. The workflow in `.github/workflows/release.yml`
builds macOS (x64 + arm64), Windows and Linux from the tagged commit; the
Publish job attaches the installers, `latest*.yml` and `sbom.json` to one
GitHub release. A release needs every platform: if one build fails, nothing is
published.

## Gates

1. `npm run typecheck && npm run lint && npm test && npm run build`
2. `npm run budget` (initial renderer JavaScript under 500 KiB)
3. `xvfb-run -a node scripts/e2e.mjs` (real window, axe, fake S3 + model)
4. `xvfb-run -a node scripts/e2e-audit.mjs` (first run, no model, demo storage)
5. `xvfb-run -a node scripts/eval.mjs --runs 2` against **two** models, at
   least one large and one small/medium context model. The smoke run only
   checks plumbing; it is not a quality result. Without `EVAL_API_KEY`, the
   workflow runs the smoke check and states that limitation in the release
   notes.
6. `xvfb-run -a node scripts/shots.mjs && node scripts/visual.mjs` (committed
   baselines under `visual/baseline`)
7. The moto compatibility job (S3, IAM, KMS; CloudTrail is reported as
   unavailable when the emulator has no endpoint).

For a local open-model baseline, point the same eval at an Ollama server.
The local server ignores the API key; set `OLLAMA_API_KEY` to any non-empty
value for the client:

```bash
EVAL_PROVIDER=compatible \
EVAL_MODEL=qwen2.5:3b \
EVAL_BASE_URL=http://127.0.0.1:11434/v1 \
EVAL_API_KEY="$OLLAMA_API_KEY" \
xvfb-run -a node scripts/eval.mjs --runs 1
```

Record its report with the release. A smoke result is never presented as a
real-model score.

## Signing and notarization

- macOS: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.
- Windows: `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`.

When every secret is present, the build signs and notarizes. When they are
absent, the workflow builds every platform anyway: macOS gets an ad-hoc
signature (so an Apple-silicon download can launch) and Windows is unsigned.
The release notes say exactly which case applies; there is no silent
"unsigned but presented as signed" path.

## Update path

Before publishing a major release, install the previous release, let it check
for the new one, download it and restart. The updater is disabled when
`STORAGE_AGENT_NO_UPDATE` is set and only runs in a packaged build. A new
release must keep the three feed names (`latest.yml`, `latest-mac.yml`,
`latest-linux.yml`) and the same `appId`. If a feed is missing, Settings says
the platform has no update feed instead of failing silently.

## What's new

Settings shows one line for the release. Keep it factual and short; the
`CHANGELOG.md` entry is the full record. There is no in-app modal.
