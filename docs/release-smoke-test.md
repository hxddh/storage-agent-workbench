# Release smoke test

Run this before publishing any desktop pre-release. Packaging smoke (build +
`/health`) is necessary but **not sufficient** — a packaged build can pass packaging checks
yet failed product smoke, so this checklist gates the product model too.

## A. Packaging smoke

- [ ] `bash scripts/build-macos-app-bundle.sh` produces an `.app` (and DMG if available).
- [ ] `codesign --verify --deep --strict "<.app>"` succeeds (no broken seal). The build
      auto-seals via `scripts/sign-macos-app-bundle.sh` (ad-hoc, **no hardened runtime**);
      `scripts/verify-macos-app-bundle.sh` also gates on this.
- [ ] Seal flags are `0x2(adhoc)` (NOT `linker-signed`, NOT `runtime`) — a `runtime`
      (hardened) seal blocks the PyInstaller sidecar from starting.
- [ ] Launch the app; the sidecar reaches **Connected** within a few seconds
      (the one-dir bundle starts fast — no per-launch extraction).
- [ ] `GET /health` on the sidecar returns `{"status":"ok"}`.
- [ ] App data is under `~/Library/Application Support/...`, not inside the `.app`.

## B. Thread-first product smoke (required)

A fresh-install user must be able to do all of this without reading source:

- [ ] On launch, the **thread-first workbench** is shown: a slim session rail (left) +
      a conversation thread with a sticky composer (center). No top-level tabs.
- [ ] On a fresh install (no providers), the **first-run wizard** appears once, then
      does not reappear after "Skip for now" or "Configure providers".
- [ ] "Configure providers" / "⚙ Settings & providers" opens the **settings drawer**.
- [ ] **Configure a model provider (LLM API key)** in the drawer (Model Providers).
- [ ] **Configure an S3-compatible cloud provider (AK/SK)** in the drawer (Cloud Providers).
- [ ] The **single composer** (no mode switch) → first message **creates and opens a
      session** that appears in the rail; messages render as inline thread cards.
- [ ] Offline triage fallback: with **no model provider/key configured**, paste a
      synthetic S3 error into the composer — a deterministic **triage card** still
      appears inline (no credentials, no LLM), alongside an inline "Add a model API key"
      prompt (not a crash).
- [ ] While the agent is streaming an answer, **Stop** cancels the turn: the stream ends
      promptly, the **partial answer is kept** in the thread with a stopped marker, and
      the composer is immediately usable for the next message.
- [ ] **Next-action proposals** render as inline cards; **Prepare** opens only the three
      purpose-built flows — evidence import (`evidence_import`), the session report
      (`session_report`), or a composer-seeded question (`message_composer`) — and every
      other proposal routes back to the agent conversationally. There is no "Review
      previews" step and no run-starter form; nothing runs without explicit confirmation.
- [ ] Runs are reachable as **expandable cards inside the thread** (Details), not as a
      separate top-level page.

## C. Anti-regressions (must NOT be present)

- [ ] No top-level tabbed admin shell (Home / Sessions / Providers / Runs / Datasets / Reports nav).
- [ ] No stale "Phase 01 / bootstrap only" copy.
- [ ] No "credentials … arrive in later phases" copy.
- [ ] No dead-end view without a next step in the thread.
- [ ] No plaintext secrets in frontend state/localStorage, logs, reports, or model prompts.
- [ ] No destructive S3 operation; no hidden auto-run / auto-confirm.

## D. Safety spot-checks

- [ ] Provider responses expose only `*_ref` + `has_*` flags, never secret values;
      `has_*_key` reflects the actual vault (a stale ref with no secret reads false).
- [ ] Generated reports contain no secrets or raw log/inventory rows.
- [ ] **No** system keychain / secret-service authorization prompt on launch
      (secrets are in the encrypted vault). On a fresh vault build, providers
      show keys as **not set** until re-entered once.
- [ ] Settings → Providers **Delete** removes a model/cloud provider via the
      inline Cancel / Confirm delete (no native `window.confirm`).
- [ ] The agent runs read-only checks itself (no autonomy toggle exists); cloud
      data-moving actions (evidence import / large scans) still require explicit
      confirmation.
