# Release

A release is a tag plus three platform builds and one GitHub release. The
workflow is `.github/workflows/release.yml`; it is triggered by a `v*` tag or a
manual dispatch with an existing tag.

## What CI checks

The normal CI workflow runs on `main` and pull requests:

- typecheck, Biome lint, Vitest, build, bundle budget, secondary-text contrast,
  production dependency audit and SBOM;
- the real-window E2E with fake S3 and a fake OpenAI-compatible model;
- the no-model first-run E2E;
- the smoke eval, the behavior bench smoke, cold-start performance, screenshots
  and visual comparison;
- on `main`, the real-model bench for a small and a large model
  (three runs per scenario) when `EVAL_API_KEY` and the model variables exist;
  without them the job says it did not run;
- the moto compatibility suite.

The Release workflow itself does not run typecheck, lint or unit tests. Tag a
commit from a green `main`; do not use the tag workflow as a substitute for CI.

## Release jobs

1. **Evaluation** — if the `EVAL_API_KEY` secret exists, the job runs
   `scripts/eval.mjs --runs 2` for the primary and secondary model variables,
   then `scripts/bench.mjs --runs 3` against the primary and the secondary
   model. If it does not exist, it runs `scripts/eval.mjs --smoke` and
   `scripts/bench.mjs --smoke`. A smoke
   report proves the harness and conversation plumbing run; it is not a
   model-quality score. The bench scores the conversation the agent produced
   (calls, citations, clarify, steer, resume, follow-ups, risk acceptance, model
   choice) and what it said.
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
when they are absent. The eval covers 29 storage scenarios; the bench covers 14
agent-behavior scenarios and scores the conversation, including a retry after a
steer, a follow-up in the same thread and accepting a risk only after the
user's click. The bench gate: every must-pass check
passes in every run and at least 90% of soft checks pass. A smoke bench uses the
same gate (the fake model is deterministic, so a failure is a plumbing
regression). Reports are attached and named after the model, never the key. A
smoke report is labeled as plumbing only.

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

The latest release is **36.0.0** (2026-10-29). Earlier release notes
may describe retired behavior; they are history. Keep `README.md`,
`CHANGELOG.md` and this paragraph in step with the next tag, and refresh
`docs/screenshot.png` if the surface changed. 36.0 makes the window a
conversation: each task is one thread of the user's messages and the agent's
steps and text, projected by `shared/conversation.ts`; every read goes through
the agent, so `Check account` and scheduled checks need a model; accepting a
risk is asked with `accept_risk` and done only by the user's click. The
scripted check and re-check, app-level answer validation, the scope line and
the evidence strips were removed. Issues still change only in
`estate/assess.ts`, loop guards still derive from durable entries, and the
schema head stays at 15; 35.x tasks open as conversations.