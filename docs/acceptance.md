# Acceptance

## Phase 01: Bootstrap

Must pass:

- GitHub private repo exists.
- Project structure exists.
- `CLAUDE.md` exists.
- `README.md` exists.
- `docs/*.md` exist.
- Tauri / React / Vite shell exists.
- Python FastAPI sidecar exists.
- `GET /health` returns OK.
- Frontend displays sidecar connected / disconnected status.
- Basic CI exists.
- No GitHub issue templates exist.
- No generic shell tool exists.
- No keyring implementation yet.
- No S3 tools yet.
- No DuckDB analysis yet.
- No destructive S3 operation exists.
- Initial commit is pushed to GitHub.

## Phase 02: Providers

Placeholder.

Expected later:

- SQLite initialized.
- keyring wrapper implemented.
- Model provider CRUD implemented.
- Cloud provider CRUD implemented.
- Secrets stored only in keyring.
- SQLite stores only secret references.

## Phase 03: S3 tools

Placeholder.

Expected later:

- Readonly S3-compatible tools implemented.
- Tool outputs sanitized.
- Tool calls audited.
- No destructive operations.

## Phase 04: Runs and timeline

Placeholder.

Expected later:

- Analysis Run model.
- SSE events.
- Tool Timeline.
- Diagnostic run.
- Markdown report.

## Phase 05: DuckDB analysis

Placeholder.

Expected later:

- Access log analysis.
- Inventory analysis.
- Metrics cards.
- Findings.
- Markdown reports.

## Phase 06: Bucket config review

Placeholder.

Expected later:

- Readonly config summary.
- Security findings.
- Lifecycle findings.
- Observability findings.
- Provider unsupported handling.

## Phase 07: Agents SDK

Placeholder.

Expected later:

- OpenAI Agents SDK integration.
- Whitelist tools only.
- Evidence-backed findings.
- Existing SSE and timeline preserved.

## Phase 08: Packaging

Placeholder.

Expected later:

- Tests.
- Examples.
- Tauri sidecar packaging.
- Demo docs.
- MVP acceptance review.

## Phase 08 acceptance (packaging)

- PyInstaller sidecar build script + spec exist; packaged entrypoint exists.
- Packaged sidecar serves `/health` in the smoke test (or a clear environment
  blocker is reported).
- Tauri config includes sidecar integration (externalBin + shell plugin +
  `get_sidecar_url`); frontend resolves the URL in dev and prod.
- Sidecar status UI handles starting / connected / disconnected / error.
- App data dir behavior implemented + documented; no secrets bundled or logged;
  no user data written to the install dir.
- Existing sidecar tests + frontend build pass; deterministic mode works without
  a model key; agent missing-key path fails cleanly.
- Rust/Tauri desktop build status is reported honestly (blocked when the Rust
  toolchain is absent).

## Phase 09 acceptance (desktop release hardening)

- Branch `phase/09-desktop-release-hardening` from latest main.
- Scripts build the sidecar externalBin and copy it to the Tauri path
  automatically (`scripts/build-sidecar-for-tauri.py`); `build-desktop-macos.sh`
  and `verify-desktop-build.sh` drive/verify the desktop build.
- `cargo check` + `cargo build` pass on macOS arm64; `cargo tauri build` works
  with the Tauri CLI installed (Option A). Frontend build + sidecar tests +
  PyInstaller smoke test pass.
- Startup UX shows a clear slow-start hint (>15s) and sanitized error guidance.
- CI gains a Rust-enabled `desktop-build-macos` job; full bundle + signing +
  notarization are intentionally skipped with a clear reason.
- App data dir behavior documented + tested; no user data in the install dir.
- No Vercel SDK; no new dangerous execution surface; no S3 mutation; Phase 10
  not started.

## Phase 10 acceptance (macOS app bundle)

- Branch `phase/10-macos-app-bundle` from latest main.
- Tauri bundle enabled (`bundle.active=true`, targets app+dmg, icon set incl.
  `icon.icns`); externalBin still packages the sidecar.
- `cargo tauri build` produces an unsigned `.app` and a DMG; artifacts are not
  committed (gitignored). CI uploads `.app` (zipped) + DMG.
- Local launch verified: `.app` starts, Tauri spawns the bundled sidecar on a
  free port, `/health` is ok; sidecar is cleaned up on exit via a parent-PID
  watchdog (no orphans). GUI screen verification needs OS Accessibility/Screen
  Recording grants (not available headlessly) — verified via process + health
  inspection instead.
- App data dir never under the install dir; secrets stay in the OS keychain.
- No signing/notarization/auto-update; macOS x64/universal not verified.
- No Vercel SDK; no new S3 mutation / shell / subprocess tool surface; Phase 11
  not started.

## Phase 11 acceptance (Linux/Windows build matrix)

- Branch `phase/11-linux-windows-build-matrix` from latest main.
- macOS arm64 build remains green (unchanged scripts; bundle targets="all" still
  yields .app + DMG).
- Linux x64 and Windows x64 CI jobs added (experimental/continue-on-error):
  frontend + sidecar build + externalBin copy + sidecar /health smoke +
  cargo check/build + cargo tauri build (.deb / NSIS), with artifact upload.
  They report pass/partial/blocker honestly and never false-green.
- externalBin helper supports Linux (`x86_64-unknown-linux-gnu`) and Windows
  (`x86_64-pc-windows-msvc.exe`) naming.
- Platform support matrix documented; macOS x86 / universal explicitly out of
  scope; no signing/notarization/auto-update.
- No Vercel SDK / Next.js; no new S3 mutation / shell / subprocess tool surface;
  Phase 12 not started.

## Phase 12 acceptance (cross-platform runtime verification)

- Branch `phase/12-cross-platform-runtime-verification` from latest main.
- macOS arm64 not regressed: .app + DMG build; runtime verifier passes all
  checks incl. launch lifecycle (verified locally with --require-launch).
- Runtime verification scripts exist: verify-runtime-common.py +
  verify-runtime-{macos.sh,linux.sh,windows.ps1}. They check app exe + bundled
  sidecar presence, direct sidecar /health, app data dir not under install dir,
  and app launch -> sidecar spawn -> /health -> quit -> cleanup.
- CI runs runtime verification in all three desktop jobs (macOS required;
  Linux via xvfb, Windows — both experimental/continue-on-error, honest output).
- Docs updated with runtime support matrix (build/smoke/launch/cleanup columns)
  and Linux/Windows promotion criteria.
- No Vercel SDK / Next.js; no new S3 mutation / shell / subprocess tool surface;
  no signing/notarization/auto-update; no macOS x86/universal; Phase 13 not
  started.

## Phase 13 acceptance (agent dataset analysis)

- Branch `phase/13-agent-dataset-analysis` from latest main.
- Agent planner mode supports `access_log_analysis` and `inventory_analysis` as
  an interpretation-only narrator; deterministic analysis still runs first and
  default planner mode stays `deterministic`.
- The model receives only a bounded, sanitized, aggregated context (run/dataset
  metadata + deterministic metrics + deterministic findings); lists capped at 20
  and asserted free of secret-shaped content before leaving the process.
- No raw log lines / inventory rows / full key lists / arbitrary SQL ever reach
  the model; the model has no tools, so it cannot run SQL, list objects, read
  raw data, download bodies, or perform any S3 operation. No new tool is
  registered; the allowlist is unchanged.
- ≤20 sample keys; client IPs masked; Authorization/cookies/presigned params /
  access-secret-session keys / model API keys redacted or absent.
- access_log output fields: executive_summary, key_observations,
  possible_root_causes, risk_level, recommended_next_steps,
  questions_for_operator, limitations. inventory output fields:
  executive_summary, storage_layout_observations,
  cost_optimization_opportunities, performance_considerations,
  lifecycle_policy_candidates, small_object_findings, large_object_findings,
  risks_and_caveats, recommended_next_steps. The narrator may recommend
  reviewing lifecycle candidates but never auto-creates/updates/deletes
  lifecycle rules or emits bulk-delete commands.
- Missing model provider key fails the agent run cleanly; deterministic mode
  unaffected. Output is chain-of-thought-stripped, redacted, and length-bounded;
  no hidden reasoning / raw prompt / raw model reasoning / secrets / raw
  logs-rows persisted.
- Report separates Deterministic metrics from the Agent Interpretation section;
  every agent claim is traceable to a deterministic metric/finding.
- Frontend New Run exposes agent mode for these two run types; Run Detail shows
  the planner badge, agent narrative, and unchanged deterministic metrics.
- Sidecar tests pass (137); frontend build + cargo check pass; guardrail grep
  passes.
- No Vercel SDK / Next.js; no MCP runtime / multi-agent / generic shell /
  user-controlled subprocess; no destructive/mutating S3; no arbitrary boto3 or
  SQL tool exposed to the LLM; no release/signing/auto-update changes; no macOS
  x86/universal; Phase 14 not started.

## Phase 14 acceptance (cloud account discovery)

- Branch `phase/14-cloud-account-discovery` from latest main.
- `list_buckets` read-only tool implemented (keyring creds, sanitized output,
  provider_unsupported/access_denied/error statuses, tool_calls + audit_logs).
- `account_discovery` run type implemented: test_credentials → list_buckets →
  per-bucket head_bucket + config snapshot + evidence discovery → profile +
  report. Enumerates visible buckets; respects `max_buckets` (default 100, hard
  cap 500) with include/exclude globs; per-bucket failures are isolated.
- Bucket config snapshot collected per bucket with clear status enums.
- Inventory and server-access-logging evidence-source discovery implemented
  (discover-only, never pulls full inventory/log); future sources marked
  `not_implemented`.
- Account profile report generated; frontend supports the account_discovery run,
  a "Discover account" entry on cloud providers, and a filterable bucket table
  with evidence-source status.
- No full object scan (no ListObjectsV2), no object body download, no mutating
  S3 API, no auto-enable of logging/inventory, no auto lifecycle/policy/ACL/
  encryption/replication change.
- No secret leak to SQLite/log/report/UI/LLM (AK/SK/session token/model key);
  provider_unsupported vs access_denied handled gracefully.
- account_discovery is deterministic only; Agent mode returns a clean 422.
- Sidecar tests pass (159); frontend build + cargo check pass; guardrail grep
  passes.
- No Vercel SDK / Next.js; no MCP runtime / multi-agent / generic shell /
  user-controlled subprocess; no arbitrary boto3 or SQL tool exposed to the LLM;
  no release/signing/auto-update changes; no macOS x86/universal; Phase 15 not
  started.

## Phase 15 acceptance (managed evidence import)

- Branch `phase/15-managed-evidence-import` from latest main.
- Inventory import plan implemented (manifest-preferred, bounded prefix-listing
  fallback, ORC detected_but_not_supported); access-log import plan implemented
  (time range required, bounded listing of the logging target prefix).
- Explicit confirmation required before any download; recorded in
  approval_events + audit_logs; no hidden auto-confirm; zero-file/over-limit
  plans refused.
- Evidence download uses only the confirmed files; `max_files` and `max_bytes`
  respected (and re-enforced at download — overflow aborts as failed).
- Imports read only the DISCOVERED inventory destination / logging target — the
  business source bucket is never listed, no business object body is downloaded,
  no recursive copy/sync, no full object scan, no S3 mutation.
- Downloaded inventory feeds the existing inventory_analysis; downloaded logs
  feed the existing access_log_analysis (reused importers/analyzers, dataset
  name = managed_evidence_import). Reports carry no raw log content and no
  secrets; evidence files land in the app data dir, not the install dir.
- Frontend supports the plan → confirm → import flow from the account profile
  bucket table and navigates to the resulting analysis run.
- Sidecar tests pass (178); frontend build + cargo check pass; guardrail grep
  passes.
- No Vercel SDK / Next.js; no MCP runtime / multi-agent / generic shell /
  user-controlled subprocess; no arbitrary boto3 or SQL tool exposed to the LLM;
  no release/signing/auto-update changes; no macOS x86/universal; Phase 16 not
  started.

## Phase 16 acceptance (session workspace context)

- Branch `phase/16-session-workspace-context` from latest main.
- Sessions data model implemented (sessions + session_runs + evidence_refs +
  findings + messages + summaries; runs gain a `session_id`).
- A run can be linked to a session (attach endpoint) and New Run can include
  `session_id`; run detail shows "Belongs to session"; session detail shows
  linked runs. Run completion refreshes the session summary.
- Deterministic, sanitized session summary implemented; findings reference a
  source_run_id and are bounded; facts/inferences/suggestions distinguished with
  confidence; next actions are proposals only (requires_confirmation).
- Session assistant implemented as interpretation-only: sanitized bounded context
  only, no tools, CoT-stripped output, clean failure on missing model key, and
  the deterministic summary is unaffected by the model key.
- Session messages persisted sanitized; session report generated with evidence
  references and no secrets / no raw content.
- Frontend has a lightweight Sessions entry (list / new / detail with goal,
  summary, run timeline, findings, next actions, message composer, report,
  "Start run in this session", "Refresh summary"); UI stays agentic, not a
  dashboard. Existing run workflows unaffected.
- No kanban / ticketing / project-management tables; no traditional cloud
  dashboard expansion; no notifications; no multi-user/permission model.
- Sidecar tests pass (193); frontend build + cargo check pass; guardrail grep
  passes.
- No Vercel SDK / Next.js; no MCP runtime / multi-agent / generic shell /
  user-controlled subprocess; no destructive/mutating S3; no arbitrary boto3 or
  SQL tool exposed to the LLM; no business object scan / body download; no
  secret or chain-of-thought persistence; no release/signing/auto-update
  changes; no macOS x86/universal; Phase 17 not started.

## Phase 17 acceptance (session next-action handoff)

- Branch `phase/17-session-next-action-handoff` from latest main.
- Next-action proposals normalized to a canonical sanitized shape with an
  `action_type` allowlist; `requires_confirmation` always true.
- Action preview API (`/sessions/{id}/actions/preview`) and prepare API
  (`/sessions/{id}/actions/prepare`) implemented; both ONLY validate + prefill —
  no run creation, no evidence download, no confirm, no S3, no LLM.
- Supported safe action types prepared into existing flows: run_* → NewRunForm
  (with session_id + prefilled run_type/provider/bucket); plan_*_import →
  EvidenceImportDialog (prefilled account run + bucket + source_type; imported
  run attached to the session; import still plan→confirm→run); generate_session_
  report → session report; ask_user_for_context → message composer. Missing
  parameters yield `needs_input` (with candidates for ambiguous evidence
  sources); access-log time range is never auto-filled.
- Session assistant can return validated/coerced `proposed_actions` (allowlist
  enforced, invalid dropped, requires_confirmation forced), interpretation-only,
  sanitized, CoT-stripped, clean failure with no model key.
- Frontend Session detail has a Review / Prepare & open flow that reuses
  NewRunForm and EvidenceImportDialog; copy states "proposed next step — review
  before starting". UI stays Agentic, not a task board.
- Audit events recorded (next_action_previewed/prepared/opened); no kanban /
  ticketing / PM tables; existing run + import workflows unaffected.
- Sidecar tests pass (211); frontend build + cargo check pass; guardrail grep
  passes.
- No Vercel SDK / Next.js; no MCP runtime / multi-agent / generic shell /
  user-controlled subprocess; no destructive/mutating S3; no arbitrary boto3 or
  SQL tool exposed to the LLM; no business object scan / body download; no hidden
  auto-run / auto-confirm; no secret or chain-of-thought persistence; no
  release/signing/auto-update changes; no macOS x86/universal; Phase 18 not
  started.

## Phase 18 acceptance (error triage assistant)

- Branch `phase/18-error-triage-assistant` from latest main.
- Error-triage data model (error_triage_cases, error_triage_findings),
  deterministic parser, playbook rules, and engine implemented.
- API implemented (`POST /error-triage`, `GET /error-triage/{id}`,
  `GET /sessions/{id}/error-triage`); deterministic is default and needs no
  model key; agent mode is interpretation-only over sanitized triage context.
- Session integration: a case binds to its session, refreshes the session
  summary, and appears in the session report's Error triage section. Frontend
  ErrorTriagePanel lives inside Session detail.
- No raw stack trace / secrets in Agent context (only parsed signals +
  candidate-cause titles/why + next checks); input is redacted before persistence.
- Triage performs no S3 call, creates no run, downloads no evidence, and mutates
  nothing; next actions are Phase 17 proposals routed through review/prepare.
- Supported categories include SignatureDoesNotMatch, AccessDenied,
  InvalidAccessKeyId, NoSuchBucket/NoSuchKey, PermanentRedirect/
  AuthorizationHeaderMalformed, RequestTimeTooSkewed, SlowDown/TooManyRequests,
  RequestTimeout/5xx, InvalidPart/EntityTooSmall, PreconditionFailed,
  InvalidBucketName, TLS/connection errors, path-style vs virtual-host, and
  pagination issues.
- Public-repo hygiene: synthetic examples only (no real customer/endpoint/
  bucket/credential data) in docs and tests.
- Sidecar tests pass (232); frontend build + cargo check pass; guardrail grep
  passes.
- No Vercel SDK / Next.js; no MCP / multi-agent / shell / subprocess; no
  destructive/mutating S3; no arbitrary boto3 or SQL-to-LLM; no business object
  scan / body download; no hidden auto-run / auto-confirm; no secret or
  chain-of-thought persistence; no FAQ / static error-code dictionary / kanban /
  ticketing / dashboard expansion; no release/signing/auto-update; Phase 19 not
  started.
