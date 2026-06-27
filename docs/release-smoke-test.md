# Release smoke test

Run this before publishing any desktop pre-release. Packaging smoke (build +
`/health`) is necessary but **not sufficient** — v0.19.0-pre.1 passed packaging
yet failed product smoke, so this checklist gates the product model too.

## A. Packaging smoke

- [ ] `bash scripts/build-macos-app-bundle.sh` produces an `.app` (and DMG if available).
- [ ] `codesign --verify --deep --strict "<.app>"` succeeds (no broken seal).
- [ ] Launch the app; the sidecar reaches **Connected**.
- [ ] `GET /health` on the sidecar returns `{"status":"ok"}`.
- [ ] App data is under `~/Library/Application Support/...`, not inside the `.app`.

## B. Agent-first product smoke (required)

A fresh-install user must be able to do all of this without reading source:

- [ ] On launch, the **Home / agent workspace** is shown (not an empty admin list).
- [ ] Home has a task composer: "What do you want to investigate?".
- [ ] Home shows **setup status** for Model provider and Cloud provider with a Configure action.
- [ ] **Configure a model provider (LLM API key)** from visible UI (Providers → Model).
- [ ] **Configure an S3-compatible cloud provider (AK/SK)** from visible UI (Providers → Cloud).
- [ ] Start an investigation from the composer → it creates and opens a **Session**.
- [ ] **Start offline error triage** without cloud credentials; paste a synthetic S3 error and get a deterministic result.
- [ ] If no model key is configured, agent interpretation **fails cleanly** (not a crash); deterministic output still appears.
- [ ] **Next-action proposals** appear and require review/confirmation before anything runs.
- [ ] Runs / Datasets / Reports are reachable as **supporting** views, not the starting point.

## C. Anti-regressions (must NOT be present)

- [ ] No stale "Phase 01 / bootstrap only" copy.
- [ ] No "credentials … arrive in later phases" copy.
- [ ] No dead-end top-level page without a next step.
- [ ] No plaintext secrets in frontend state/localStorage, logs, reports, or model prompts.
- [ ] No destructive S3 operation; no hidden auto-run / auto-confirm.

## D. Safety spot-checks

- [ ] Provider responses expose only `*_ref` + `has_*` flags, never secret values.
- [ ] Generated reports contain no secrets or raw log/inventory rows.
