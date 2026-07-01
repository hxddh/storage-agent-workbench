# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow semantic versioning once it reaches 1.0.

## [Unreleased]

## [0.21.0] - 2026-07-02

_"还债与收敛" — closes every finding verified in a third-party v0.20.11 review:
documentation debt, dead guardrail ceremony, grounding-lost-on-reload, skill
gaps, stale triage names, four frontend UX gaps, and legacy-API/dependency
hygiene. Two findings were closed the agent-native way rather than as the review
literally suggested — the dead tool-allowlist ceremony was **deleted** (not
wired), and the proposal `action_type` naming was **documented** (not renamed) —
both to avoid re-introducing churn/ossification. No change to the single-agent
loop, the bounds-not-gates safety model, or the read-only security floor._

### Build / API hygiene

- **Pinned the fast-moving AI SDKs for reproducibility.** `openai` and
  `openai-agents` had only `>=` floors far below the installed versions, so CI
  (which installs from `pyproject`, no lockfile) could silently pull a breaking
  release. Bounded to the tested range: `openai>=2.40,<3`,
  `openai-agents>=0.17,<0.18` (pre-1.0 → cap at the next minor).
- **`POST /runs` documented as internal/testing.** It is not a user surface (the
  frontend never calls it; the agent drives runs via `run_service`, evidence
  import creates its run server-side). Clarified in the `runs` router docstring
  and `docs/api.md`; kept because the deterministic run layer is the
  reproducibility/security floor and the test suite creates runs through it.
- **Removed the dead `not_implemented` run branch.** `run_type` is a `RunType`
  Literal (FastAPI 422s anything else) and every value is executable, so the
  fall-through placeholder was unreachable; replaced with a defensive 422.

### Frontend

- **Attach-only send.** The composer's send button (and Enter) were disabled
  whenever the text was empty, even with a file attached — so "analyze this file"
  with no typed message was impossible. Send is now enabled when either text or an
  attachment is present.
- **Session findings surface in the thread.** A read-only, collapsible
  `FindingsCard` renders the persisted deterministic session findings the API
  already held — previously visible only in the report.
- **EvidenceImportDialog is localized.** Its ~25 hard-coded English strings now go
  through `t()` with full en/zh entries (title, plan fields, buttons, hints).
- **Removed the dead `SidecarStatus` component.** The `.tsx` component was never
  rendered (only the same-named *type* from `useSidecarHealth` is used); deleted
  to cut confusion. The health hook itself is unchanged.

### Fixed

- **Stale tool name in triage playbooks.** The offline error-triage `next_checks`
  suggested `get_bucket_location`, which is not a tool the agent exposes;
  replaced with `get_bucket_config_summary` (which reads region/location) across
  all affected playbook entries.

### Changed

- **Offline triage now points at the specialist skill.** Each triage category
  maps to the StorageOps skill whose method applies (`authz` →
  security-iam-policy, `routing`/`auth` → s3-protocol-compatibility, etc.), and
  the triage result carries a `suggested_skills` pointer (derived, not persisted).
  Deterministic triage can't `read_skill` itself, but this lets a session agent
  jump straight to the right method and tells an offline user which skill covers
  their case. Unmapped categories fall back to `storageops-triage`.
- **Documented the proposal `action_type` → execution mapping** in
  `next_actions.py` (report §P3). The `run_*` slugs are internal/audit-only (the
  user only ever sees the proposal title + a localized prompt), so they are kept
  stable rather than renamed — a comment now records what each actually does
  (e.g. `run_diagnostic` → the agent's adaptive probe chain, not a run).

### Skills

- **Filled the verified skill gaps (18 → 20 skills).** Two genuinely-missing
  methods added: `storageops-workbench-investigation` (the general observe →
  probe → verify → ground → propose loop, previously only implicit in the agent
  prompt) and `storageops-observability-audit` (logging + notifications + metrics
  + inventory + tagging as one coherent audit, catching "logging enabled but
  delivered nowhere" gaps). The two partially-covered areas were **expanded in
  place, not fragmented**: a public-exposure pass added to
  `storageops-security-iam-policy` and a provider capability matrix added to
  `storageops-s3-protocol-compatibility` (with registry routing updated).
- **Tool hints where they were missing.** `preview_object` referenced from
  `cli-sdk-diagnosis` + `data-consistency`; `list_uploaded_files` referenced from
  `access-log-analysis` + `inventory-analysis`; `storageops-triage` decision tree
  now routes to account-posture / inventory / observability / evidence-reporting /
  workbench-investigation.
- **`skills_used` cap raised 3 → 6** to match the per-turn `read_skill` budget, so
  a turn that legitimately loaded several skills reports all of them (the
  bound-to-actual-`read_skill` honesty filter is unchanged).

### Added

- **Grounding + proposed actions now persist per assistant turn (survive
  reload).** Migration 16 adds `session_messages.grounding` and
  `.proposed_actions` (sanitized JSON). Previously the transparency payload
  (`evidence_used` / `evidence_gaps` / `skills_used`) and the turn's next-action
  proposals rode only the transient SSE `done` event, so a page reload dropped
  them and a historical turn could no longer show *why* it said what it said. The
  backend now stores them on the assistant message and returns them from
  `GET /sessions/{id}/messages`; the frontend renders the grounding card +
  proposal chips **per assistant message** from the persisted data (a single
  source of truth) instead of a transient bottom block. `tool_activity` (already
  persisted) is unchanged; `evidence_used` remains the model's self-report, kept
  distinct from the mechanical tool trace.

### Removed

- **Dead guardrail ceremony (`check_tool_allowed`, `ALLOWED_TOOLS`,
  `approval_category`).** These were never called on the live agent path — a
  redundant static allowlist that had to be hand-synced with the real tool
  registration, plus a `max_keys > 1000` "approval" category that could never
  trigger (the agent's list size is clamped by `bound_tool_args`, not gated).
  Keeping them would have re-introduced an ossification point (adding a read-only
  tool would require editing a second list) that violates the project's
  "bounds, not gates" line. The tool **whitelist is the curated
  `@function_tool` registration** in `session_tools` / `session_action_tools` /
  `session_analysis_tools` / `session_memory_tools`; the forbidden-token/phrase
  **denylist** (`is_forbidden_tool`, still live in proposal-slug sanitization) is
  the defense-in-depth net and is now asserted over the *real registered* tool
  set in `test_agent.py` (which also gained the 0.20.9–11 tools). `bound_tool_args`
  and all sanitization/secret-assertion helpers are unchanged. No runtime
  behavior change for the agent.

### Documentation

- **Truth-up pass on stale docs (no behavior change).** A third-party review
  found the docs describing an older, runs-first design. Corrected across
  `architecture.md`, `security.md`, `tools.md`, `api.md`, `product.md`, the skill
  registry header, and three module docstrings:
  - Skill count 16 → 18; removed references to the deleted `skills/selection.py`
    lexical selector and the removed `read_skill` "tools-disabled preamble"
    (`read_skill` returns a frontmatter-stripped, length-bounded body).
  - Reframed the product flow from "Goal → Evidence → Runs → …" to agent-first
    (agent drives; runs are the auditable/security floor beneath it); noted that
    only `origin !== 'agent'` runs card in the thread.
  - Documented the 0.20.9–0.20.11 tools in `tools.md`
    (`list_object_versions`, `list_multipart_uploads`, `measure_request_latency`,
    `get_object_lock_status`) and corrected "cannot download object bodies" to the
    bounded `preview_object` / `test_range_get` exception.
  - `api.md`: SSE `done` event documents the grounding fields
    (`evidence_used` / `evidence_gaps` / `skills_used`, added 0.20.8).
  - Removed stale mentions of a preview endpoint / `NewRunForm` / an
    interpretation-only triage Agent (triage is deterministic; interpretation is
    the session agent in-thread).
  - Noted registry `trigger_keywords` / `domains` / `auto_route` are parsed but
    currently unconsumed (no offline selector).

## [0.20.11] - 2026-07-01

### Added

- **`measure_request_latency` — the agent can now MEASURE latency, not just guess
  at it.** Performance diagnosis previously had no way to time anything: the
  bucket performance profile only inferred small-file overhead from object-size
  metadata. This tool fires a bounded set of lightweight head round-trips
  (HeadBucket, or HeadObject on a named key — never an object body) and returns
  min/p50/p95/max/mean milliseconds, turning "it's slow" into numbers. It is a
  diagnostic probe, not a load test: the per-call sample count is hard-capped
  (≤10) and probe runs are bounded per turn. The `storageops-performance-diagnosis`
  skill now points at it as the first step for any speed complaint.
- **`get_object_lock_status` — object-level retention + legal-hold read.** Answers
  "why can't I delete/overwrite this object?" by reading one object's actual
  retention mode + retain-until date (`GetObjectRetention`) and legal-hold status
  (`GetObjectLegalHold`). Bucket config review could only show *whether*
  object-lock is enabled on the bucket, never a specific object's lock. Read-only;
  a missing lock, or a provider that doesn't implement object-lock, is reported as
  a normal `none` / `provider_unsupported` state rather than a hard failure. The
  `storageops-replication-versioning` skill references it for object-lock puzzles.

Both tools are read-only, sanitized, and enforce safety through code-level bounds
(sample caps, per-turn budgets) rather than confirmation gates — the agent-native
"bounds not gates" line. No object bodies are read by either; no write path is
added. 9 new tests (Stubber-backed); full suite 295 passing.

## [0.20.10] - 2026-06-30

### Added

- **Two read-only data-level tools the agent was missing — version pileup and
  abandoned multipart uploads.** Config review could only see *whether* versioning
  and cleanup rules exist, never the actual data behind unexplained bucket
  size/cost. The agent now has:
  - `list_object_versions` — the real noncurrent-version + delete-marker pileup
    (counts, current vs noncurrent bytes, ≤20 sample keys) — the concrete answer
    to "why is my versioned bucket so large/expensive?".
  - `list_multipart_uploads` — incomplete/abandoned multipart uploads (a common
    silent cost leak: parts billed but invisible in a normal listing). **List
    only** — aborting is a mutation and stays out; the agent proposes a lifecycle
    rule instead.
  - Both are read-only, bounded (≤1000/page + paging, ≤20 sample keys), sanitized,
    inline (no confirmation — same tier as `list_objects`), and report
    `Provider unsupported` cleanly on S3-compatible providers that lack them. The
    lifecycle-cost and replication-versioning skills gained capability hints
    pointing at them.

## [0.20.9] - 2026-06-30

### Added

- **`preview_object` — the agent can now read a bounded preview of an object's
  content.** Previously the agent could enumerate keys and read metadata
  (`head_object`) but could not look *inside* an object. It now has a read-only
  `preview_object(provider_id, bucket, key)` tool: a single bounded Range GET
  (hard cap 1 MiB/call), text-only (binary/oversized objects are reported, not
  decoded), redaction-passed, never persisted, and bounded per turn (a few
  objects / a few MiB) so it can't be looped into a bulk download. This makes
  "what's inside this manifest / config / log object?" answerable inline.
  - **Agent-native by bounds, not a gate:** no per-call confirmation (that would
    ossify the loop) — safety is code-enforced caps + sanitization + audit, the
    same model as the other read-only probes.
  - **Security rule #11 updated** accordingly: from "no object bodies by default"
    to "no *bulk* body downloads, with `preview_object` as the one bounded,
    audited, per-turn-capped exception." Bulk/recursive/full-object downloads
    remain prohibited; evidence import (GB-scale) still requires confirmation.

## [0.20.8] - 2026-06-30

### Fixed

- **Interrupted runs no longer report as forever-running.** A run left
  `pending`/`running` when the app quit mid-flight (in-process run threads can't
  survive a restart) is now reconciled to `failed` (interrupted) on startup, so
  `read_run_result` and run cards don't show it as perpetually running.

### Added

- **The agent now shows what its answer is grounded in.** A compact, collapsed
  "Why this answer" affordance under a turn surfaces the contract's
  `evidence_used`, `evidence_gaps` ("not yet verified" — what the agent couldn't
  confirm / needs from you), and `skills_used`. The backend already produced
  these; they were being dropped. Transparency only — no new capability, and the
  agent stays a read-only investigator.

## [0.20.7] - 2026-06-30

### Fixed

- **Clicking a suggested next-step no longer drops the literal text "None" into
  the composer.** A proposal with an explicit null `title`/`reason` was stringified
  as Python `str(None)` → `"None"` in `normalize_proposal` (the `get(k, "")`
  default only applies to *absent* keys, not present-but-null ones), which then
  surfaced as the `ask_user_for_context` composer prefill. Null/None now coerces
  to `""`, so `title` falls back to the action-type label and `reason` becomes
  `None` (and the prefilled question is always a real sentence).

## [0.20.6] - 2026-06-30

### Added

- **Two StorageOps skills for gaps the tools already supported** (catalog now 18):
  - `storageops-inventory-analysis` — how to read an inventory for capacity and
    object-shape (size/count, size histogram, prefix and storage-class
    distribution, small-object ratio, largest objects) via `analyze_uploaded_file`
    (attached file) or a confirmed `plan_inventory_import` (+ `read_run_result`).
    The fact layer beneath the lifecycle/cost decision.
  - `storageops-account-posture` — how to use `survey_account` for an account-wide
    landscape + config posture (logging / inventory / lifecycle / public-access-
    block per bucket) and where to look first, with `read_run_result` for a
    backgrounded survey. The no-error audit entry point (vs triage's error path).
  - Both are written agent-native: on-demand knowledge with adaptive decision
    trees and capability hints, **not** fixed pipelines (account-posture explicitly
    says not to reflexively review every bucket); app-native tool names only;
    guidance-only. `eval-golden-cases` gains a "coverage honesty" check (don't
    assert a feature absent when `access_denied`; snapshot ≠ trend; visible vs
    total buckets). Routing relies on the distinct catalog descriptions.

## [0.20.5] - 2026-06-30

Skill-pack hygiene from a coverage review — agent-native (skills stay on-demand
knowledge the agent reasons over, never control flow); no new skills yet.

### Changed

- **Protocol skill now routes CORS to a real tool.** `storageops-s3-protocol-compatibility`
  listed CORS in its triggers but never told the agent how to inspect it; it now
  points a CORS failure at the read-only `review_bucket_security` (which reads the
  bucket's CORS rules) — as a conditional capability hint, not a mandatory step.
- **Access-log skill names `read_run_result`.** When a `plan_access_log_import`
  finishes in the background, the skill now says to pick the result up with
  `read_run_result(run_id)` instead of re-importing.
- **Skill catalog wording is less run-centric** — "run a survey/review inline, or
  propose a confirmed import" rather than "propose confirmed runs".

### Removed

- **Dead skill-injection path.** Deleted `skills/selection.py` (the lexical
  selector) and `skills.context.build_skill_context` / `WRAPPER_PREAMBLE` — the
  legacy eager-injection path superseded by the live catalog + `read_skill`
  progressive disclosure. Nothing in production used them (offline triage is
  deterministic and loads no skills); only their own tests did. Tests trimmed
  accordingly, keeping live-path coverage (catalog, `read_skill`, frontmatter
  stripping).

## [0.20.4] - 2026-06-30

### Fixed

- **A step-budget (`max_turns`) limit no longer breaks the session.** Previously
  a complex investigation that exhausted the turn budget surfaced a hard
  "Max turns (16) exceeded" error, lost the whole turn, showed a misleading "open
  settings" action, and (because the failed stream fell back to the blocking
  turn) re-ran the entire agent a second time. Now, when the budget is reached,
  the agent makes one **tool-less finalize call** that synthesizes a grounded
  best-effort answer from the investigation so far (explicitly marked as possibly
  incomplete, with an offer to continue). The turn budget is unchanged and still
  bounded (N tool-loop turns + 1 tool-less finalize); the client never sees a
  max-turns error and never double-runs. The agent is also instructed to converge
  and checkpoint findings (`record_finding` / `note_fact`) as it works, so a
  "continue" follow-up resumes from real context.
- **The model chip refreshes after first-run configuration.** Adding the first
  model provider through the Settings drawer (e.g. via the first-run wizard)
  changed neither sidecar-readiness nor the active session, so the composer chip
  stayed on "Add model" until a session switch — even though chat already worked.
  The chip now re-fetches when the Settings drawer closes.

## [0.20.3] - 2026-06-30

### Fixed

- **The thread no longer looks frozen while the agent is generating.** After the
  tool trace appears, the post-tools / between-rounds wait (often the longest,
  with no streamed text yet) showed only a lone blinking caret. It now shows an
  explicit animated "Working… (still running)" indicator until the answer starts
  streaming.
- **Error-triage next-step chips survive a reload / session-switch.** The
  deterministic `safe_next_actions` were only on the POST response, so reopening
  a session showed empty chips. `GET /error-triage/{id}` and
  `GET /sessions/{id}/error-triage` now re-derive them deterministically from the
  stored (already redacted) input — no new storage, no migration.

### Changed

- **Tool-name consistency (`§2.4`).** The error-triage playbooks, `docs/tools.md`,
  and the `CLAUDE.md` whitelist now use the agent-facing tool names
  (`test_addressing_style`, `inspect_endpoint_tls`) that the SKILL.md bodies and
  agent instructions already use — so guidance never names a tool the agent
  can't call. (The underlying S3-layer functions keep their names:
  `test_path_style_vs_virtual_host`, `inspect_tls`.)
- **`read_run_result` is now listed in the agent's main tool instructions**, not
  only in the survey-timeout note — so the agent knows it can re-read a
  backgrounded survey/review/import result in a later turn instead of re-running.
- **Stale docs/docstrings** aligned to the single-agent model: `architecture.md`
  (removed "analysis narrators"; skill context is catalog + `read_skill`
  progressive disclosure, not eager 1–3 selection; triage flow has no "optional
  Agent interpretation"); `skills/__init__.py`, `skills/context.py`,
  `skills/contract.py` (no "triage Agent" / eager-injection framing);
  `pyproject.toml` (no "agent planner mode"); `summary_builder.py` comment
  (proposals are free-form, not a fixed allowlist).

## [0.20.2] - 2026-06-30

Post-v0.20 review cleanup — no behavior change beyond stronger redaction.

### Security

- **Shared redactor now scrubs model API keys (`sk-…`).** Defense-in-depth: a
  model key pasted into the chat or echoed in a provider error is masked
  everywhere the shared redactor runs (session messages, audit logs, reports),
  not just on the triage path. Aligns with security rule #15.

### Removed (dead code from the v0.20 single-agent migration)

- `analysis/drilldown.py` + its test — the bounded-aggregate tools whose only
  consumer (the deleted in-run analysis narrator) is gone.
- `runs/analysis_report.py`: `agent_analysis_md` + `render_agent_report` (the
  "Agent Interpretation" / "Agent mode" report sections) and the now-empty
  `agent_section` parameter on the dataset-report renderers.
- Frontend dead API: `uploadDataset` (run-scoped upload) and `listDatasets`.
- `next_actions.ALLOWED_ACTION_TYPES` dead back-compat alias.

### Changed (stale docs / comments)

- `docs/architecture.md`: `account_discovery` description no longer claims an
  "Agent mode 422 / future phase" — it's the agent's `survey_account` tool.
- `CLAUDE.md`: dropped the dead `optimization_report` capability bullet.
- `agent_runtime/__init__.py`, `guardrails.py`, `main.py`: docstrings no longer
  describe an "agent planner mode" (there is one conversational agent).
- `next_actions.normalize_proposal` docstring: clarified it accepts any safe
  free-form action_type (not a fixed allowlist).
- Frontend `RunEvent`: removed the never-emitted `plan` / `tool_selected` types.
- Stripped historical "(Phase NN)" provenance tags from module docstrings
  (migration provenance comments kept).

## [0.20.1] - 2026-06-30

### Fixed

- **Empty-state subtitle no longer overpromises.** "Read-only by default — I'll
  ask before running anything" became "Read-only and never destructive — I'll
  ask before moving any data" (zh equivalent): the agent runs read-only checks
  itself; only cloud data-moving work is confirmation-gated.
- **Backgrounded survey/review now resumes via `read_run_result`.** When an
  inline survey/review exceeds the time budget, the timeout note and the agent
  instructions now tell the agent to call `read_run_result(run_id)` in a later
  turn instead of re-running the survey.
- **Triage `safe_next_actions` are now clickable.** `TriageCard` renders the
  deterministic next-check proposals as one-click chips (same handoff as agent
  proposals), instead of dropping a field the API already returned.
- **Doc residual:** `docs/security.md` "Graded execution" no longer references
  the removed `autonomous_readonly`/`assisted` autonomy policy.

## [0.20.0] - 2026-06-30

**Single-agent architecture.** This release finishes the agent-native migration
by eliminating the dual-track design: there is now exactly **one** LLM in the
product — the conversational session agent. Everything under `runs/` is pure
deterministic compute the agent invokes as a tool or saves as an auditable
report artifact. No second "run-planner" LLM, no in-run interpretation
narrators, no `planner_mode` switch. The deterministic engines, DuckDB, the S3
read-only whitelist, output sanitization, and the confirm gate on data-moving
work are all kept — they are the security floor.

### Removed

- **The run-planner agent.** Deleted `agent_runtime/tool_registry.py`,
  `prompts.py`, `context_builder.py`, `result_parser.py`, and the
  `agent_service.run_agent` / `ToolInvoker` machinery. `agent_service.py` now
  keeps only `build_agent` / `get_model_credentials` for the conversational
  agent.
- **In-run interpretation narrators.** Deleted
  `agent_runtime/analysis_agent.py` (the `access_log_analysis` /
  `inventory_analysis` narrator, which used the `analysis/drilldown.py` aggregate
  tools) and `error_triage/triage_agent.py`. Analysis and triage are
  deterministic-only; the conversational agent narrates the sanitized result if
  asked. (`analysis/drilldown.py` was left orphaned and is removed in 0.20.2.)
- **`planner_mode`.** Dropped from the API (`RunCreate`/`RunSummary`/`RunDetail`,
  `ErrorTriageRequest`), the run SSE `run_started` event, the frontend types, and
  the run-detail UI. `run_service.run_sync` always dispatches a run to its
  deterministic executor; the `runs.planner_mode` SQLite column is retained
  (defaulting to `'deterministic'`) only because the schema is append-only and is
  no longer read or written.
- **The `optimization_report` run type** (never implemented as a real executor);
  an unknown `run_type` is now a clean 422.

### Changed

- **Runs expose only their real tool trace, findings, and summary** — no canned
  step "plan" event and no agent-authored prose section in reports.
- **Evidence import is reached through the agent**, not a separate panel —
  `AccountProfilePanel` is now a read-only profile view.

### Added

- **`read_run_result(run_id)`** tool — lets the agent pick up a backgrounded
  survey/review/import result in a later turn (status + sanitized summary; only
  runs linked to the current session) instead of re-running.

## [0.19.29] - 2026-06-30

Cleanup pass resolving the verified-true items from a code/skills review — no
new behavior, all agent-native consistency, dead-code removal, and small fixes.

### Fixed

- **Slash `/logs` and `/inventory` now open the file picker** (like the
  empty-state chips), instead of seeding a prompt the agent has no file to act on.
- **The model chip recovers from a transient sidecar blip** — `refreshModel`
  retries a few times instead of getting stuck on "Add model" until a refresh.
- **Sending an ambiguous-type attachment gives feedback** (a "choose a type"
  hint) rather than a silent no-op.

### Changed

- **`skills_used` is bound to skills actually loaded** via `read_skill` this turn
  — the model can no longer *claim* a skill it never opened (keeps the report
  honest).
- **Skill selection is robust to spacing/punctuation** — a keyword like
  `SignatureDoesNotMatch` matches `"Signature Does Not Match"` / `"access-denied"`
  without a hard-coded error→skill map (still metadata-driven).
- **`read_skill` has a per-turn budget** (max 6 loads) so a loop can't pull every
  skill body into context.
- **The deterministic session report labels its "next actions"** as rule-derived
  suggestions, distinct from the agent's own proposals.
- Refreshed stale `SKILL.md` guidance (access-log, lifecycle-cost, performance,
  security-iam, migration, replication) to the current tools: local files →
  `analyze_uploaded_file` inline; config/account → `review_bucket_config` /
  `survey_account`; only cloud imports stay confirmed.

### Removed

- Dead `/sessions/{id}/actions/preview` endpoint + `preview()` + the frontend
  `ActionPreviewResult` type.

### Docs

- Rewrote `docs/architecture.md` to the agent-native model (no autonomy toggle,
  no `new_run` form, free-form proposals, `origin='agent'` runs hidden from the
  thread); fixed the `session_agent` module header (attached files analyzed
  inline) and the inline-survey timeout note.

## [0.19.28] - 2026-06-29

Completes the agent-native rebuild: the conversational agent is the **sole**
operating surface, and no rigid/ossified pipeline remains. Deterministic engines
survive only as the security/reproducibility floor the agent invokes (and as
opt-in auditable reports) — never a UI-fired flow or a card mid-conversation.

### Changed

- **No run card ever appears from a conversation.** The agent's own read-only
  survey/review tools (`survey_account`, `review_bucket_config`) now record runs
  with `origin='agent'` (migration 15) that the thread filters out — the agent
  narrates the result inline instead. This removes the stray deterministic
  `account_discovery` card that could fire mid-chat (e.g. while analyzing an
  uploaded log).
- **Retired the agent-autonomy toggle entirely.** The agent is always a fully
  autonomous read-only investigator; the `assisted`/`autonomous_readonly` setting,
  its endpoint, and its Settings UI are gone. Read-only investigation always runs;
  cloud data-moving work still always requires confirmation.
- **The agent stays on the user's request.** New instructions stop it from firing
  cloud probes (credentials, account survey) for a local-file task — it analyzes
  the attached file and answers, touching the cloud only when asked.
- **Removed the retired `new_run` form handoff** from next-action proposals:
  investigation/diagnosis/config/account/analysis proposals route back to the
  agent conversationally; only evidence import, the saved report, and a context
  question get a purpose-built flow.

### Fixed

- Uploading a file no longer loses it if the upload fails (the composer is
  cleared only after success).
- Forking a session now copies its uploaded datasets and their files on disk.
- Re-uploading the same filename reuses the dataset row instead of leaving
  duplicate records pointing at one overwritten file.
- A streamed turn that ends without a completion event now reconciles via the
  blocking fallback instead of showing an empty next-steps list.
- Empty-state "Analyze access logs" / "Inventory" chips open the file picker.

### Removed

- Dead code: `agent_runtime/autonomy.py`, the `/settings/autonomy` endpoint, the
  frontend `previewSessionAction`, and stale docs/comments (README confirmation
  wording, composer "two modes", the M012 "OS keychain" note, the "Phase 17
  allowlist" comment).

## [0.19.27] - 2026-06-29

This release removes the ossified, fixed-pipeline flows so the conversational
agent is the sole driver throughout. The deterministic compute that remains is
the security/reproducibility floor the agent invokes — never a reflex the UI
fires or a canned plan the agent is marched through.

### Changed

- **No more canned "plan" pipelines.** Every run executor (access-log, inventory,
  diagnostic, config-review, account-discovery) used to publish a hardcoded
  step-list as a "plan" event — the rigid card you'd see regardless of the data
  or your question. Removed everywhere; runs now expose only their real tool
  trace, findings, and summary, and the run-detail "Agent plan" card is gone.
- **The agent proposes free-form next steps, not a fixed menu.** Next-action
  proposals are no longer capped to 9 hardcoded `action_type`s (anything else
  used to be silently dropped). The agent now suggests any concrete next step in
  its own words; well-known ones keep a one-click affordance, the data-moving
  imports still route through the confirm-before-download planner, and anything
  else is handed back to the agent to carry out conversationally. A
  forbidden/destructive token in a proposal is still rejected outright.
- **Uploading a file is now agent-native — no more canned analysis run.**
  Attaching a log/inventory file in a session and asking "分析下" used to bypass
  the conversational agent entirely and fire a fixed deterministic
  `access_log_analysis` run (a rigid 5-step plan, `planner: deterministic`, a
  templated one-line summary). The file is now attached to the **session**, and
  your message goes to the conversational agent as a normal turn. The agent
  discovers the upload (`list_uploaded_files`), analyzes it locally with a new
  read-only `analyze_uploaded_file` tool (same DuckDB engine, sanitized
  aggregates only — ≤20 sample keys, no raw rows), and answers conversationally.
  If the file isn't actually a recognized access log/inventory (e.g. a generic
  app log with no HTTP fields), the agent says so instead of reporting empty
  metrics as if they were real. The deterministic analysis run still exists as an
  explicit, auditable capability.

### Added

- `POST /sessions/{id}/datasets/upload` — attach a data file to a session for
  agent-native analysis (migration 14: `session_datasets`).
- Session agent tools `list_uploaded_files` / `analyze_uploaded_file`
  (`agent_runtime/session_analysis_tools.py`), always available (local,
  read-only, sanitized).

## [0.19.26] - 2026-06-29

### Fixed

- **Log analysis no longer crashes on plain `.log`/`.txt` files.** Uploading a
  generic application log and asking the agent to "分析一下" used to surface a
  `ParserError` (the CSV fallback choked on ragged lines). The access-log parser
  now ingests any non-empty text line as a raw row, the CSV path skips malformed
  lines instead of raising, and a truly empty file produces a clear, friendly
  message instead of a cryptic stack trace. `.txt`/`.log` are fully supported.
- **Finished/failed runs show what they actually did.** Opening a run that had
  already terminated (e.g. a failed `diagnostic`) showed an empty timeline and a
  misleading "Waiting for plan…". The run detail now seeds its timeline from the
  persisted tool calls and falls back to the saved summary/error and report when
  no live stream replays, so a terminal run is never blank.

### Changed

- **The agent diagnoses adaptively instead of firing a canned pipeline.** Removed
  the architectural "ossification" where connectivity/credential/addressing
  questions reflexively triggered a fixed `diagnostic` run. Under the autonomous
  policy the in-chat agent now investigates with its own read-only tools
  (`test_credentials`, then branching to addressing/TLS/head-bucket/list/range
  checks) and explains the root cause. The deterministic `diagnostic` run still
  exists as an explicit, auditable report when you want a saved artifact.
- **Removed the out-of-place "梳理账号" (Discover account) button from Settings.**
  Account discovery belongs in a conversation, not the provider settings list;
  the orphaned button and its plumbing are gone.

## [0.19.25] - 2026-06-29

### Fixed

- **No more dangling user message on a failed turn.** The blocking message path
  used to persist your message before calling the agent, so a clean failure (no
  model key → 422) left a question with no answer in the thread. It now persists
  the message and answer together only on success — matching the streaming path.
- **Forking a session keeps the agent's memory.** `fork` now copies the agent's
  recorded facts/findings/open-questions, so a branched conversation doesn't lose
  context. (Deleting a session already cleaned memory up via cascade.)
- **Account discovery from Settings lands in a conversation.** The Discover
  button now spins up a session and opens it, so the run lives in a timeline
  instead of as an orphaned, invisible run.

### Changed

- README intro reconciled with the autonomy model (it no longer says the agent
  "never runs an action on its own"; it never *mutates* and always confirms
  data-moving steps, but can run read-only checks itself).
- The "enumerate completely" guidance now accounts for paginated object listings
  (page via the continuation token; for very large buckets report the exact count
  + a sample and offer an inventory analysis instead of pasting thousands of keys).
- Agent context fact cap aligned with the summary builder (50); stale
  "interpretation-only / assisted+" docstrings corrected to the live
  tool-calling, autonomous-read-only reality.
## [0.19.24] - 2026-06-29

### Fixed

- **"database is locked" during autonomous turns.** When the agent ran a
  read-only run itself (e.g. account discovery) during a chat turn, the turn's
  connection held the SQLite write lock across slow S3 calls (an uncommitted
  audit row), starving the run's background writes until they failed — which the
  agent then narrated as "tools locked / database contention." Session tools now
  commit their audit row immediately, keeping the write transaction tiny.
  `account_discovery` stays fully inline and autonomous. (Reproduced + regression
  test.)

### Added

- **Attach a dataset to analyze, right in the chat composer** (Codex/Cursor
  style). A 📎 button (and the "analyze inventory / access logs" suggestions)
  let you pick a local inventory (CSV/Parquet) or access-log file; the type is
  inferred from the file (with an Inventory/Access-logs toggle when ambiguous),
  and a session-bound analysis run streams inline as a thread card. This replaces
  the removed run-form file picker — the "analyze inventory/access logs" proposals
  now actually work end to end instead of dead-ending in a plain message.
## [0.19.23] - 2026-06-29

### Fixed

- **No more duplicate runs or messages when a stream drops mid-turn.** Each chat
  turn now carries a client turn id; if the streaming attempt breaks and the
  blocking fallback re-runs it, the server dedups — it won't re-persist a turn
  the stream already completed, and the agent reuses (rather than re-creates) any
  read-only run the failed attempt had already started.
- **Session-switch race.** Switching sessions while one is still loading no
  longer lets the slow response overwrite the now-current session's view.
- **Run detail race + silent load failure.** Opening runs quickly no longer lets
  a stale fetch overwrite the current run, and a failed load now shows an error
  instead of hanging on "Waiting for plan…".
- **Session actions surface failures.** Rename / pin / archive / delete / fork
  failures now show a banner instead of being silently ignored; a failed
  send-while-sidecar-not-ready keeps your text and shows the error.
- **Slow runs keep streaming.** The run event stream now sends heartbeats and
  stays open while a run is active (with an absolute backstop), instead of
  dropping the live timeline after 120s of silence on a slow run.
- **Unreadable secret vault is explained.** If the vault can't be decrypted,
  Settings now shows a clear warning (and how to recover) instead of just showing
  keys as "not set".
- **Inline runs that time out no longer mislead the agent.** When a read-only run
  exceeds the inline budget and continues in the background, the tool result
  tells the agent it's still running so it won't state premature findings.
- Internal: `may_execute` now matches the actually-inline-executable tools
  (`generate_session_report` is proposable, not auto-run) — no behavior change,
  removes a latent policy/tool inconsistency.

## [0.19.22] - 2026-06-29

### Fixed

- **Agent memory now surfaces the most recent learnings, not the oldest.** In a
  long session, facts/findings recorded past the per-kind cap were dropped from
  the agent's context while stale early ones lingered; the context now keeps the
  newest items, and the memory query is bounded so it can't grow without limit.
- **Inline read-only runs can no longer make a chat turn hang indefinitely.**
  When the agent runs a read-only run itself (autonomous mode), it's now bounded
  by a wall-clock timeout — a heavy/slow run (e.g. account discovery over a large
  account) keeps going in the background and the turn proceeds instead of
  stalling.
- **Object enumeration can't flood the model context.** `list_objects` now caps
  the number of keys returned to the agent per call (the exact count is still
  reported and paging via the continuation token still works), so walking a huge
  bucket page-by-page won't blow up context/cost.
- **An unreadable secret vault is preserved, not silently discarded.** If the
  vault can't be decrypted (e.g. the key file was lost), the original is backed
  up as `secrets.enc.unreadable` and a warning is logged, instead of quietly
  starting blank and overwriting it on the next save.

## [0.19.21] - 2026-06-29

### Fixed

- **Configured model and cloud providers can now be deleted.** The Delete button
  in Settings → Providers relied on the browser's `window.confirm`, which is a
  no-op in the Tauri webview, so the confirmation never returned and the delete
  never fired. Replaced it with the same inline two-step confirm (Cancel /
  Confirm delete) the session rail already uses, and surfaced any backend error.

## [0.19.20] - 2026-06-29

### Added

- **The Agent now has working memory.** As it investigates, it can record
  durable facts, findings, and open questions (`note_fact` / `record_finding` /
  `note_open_question`) into per-session memory, which is fed back into later
  turns. Previously its live discoveries evaporated once the message window
  rolled — only deterministic run artifacts persisted. Memory is sanitized
  (no secrets/raw rows) and audited like all agent output.
- **The Agent can enumerate large buckets.** `list_objects` now supports
  continuation tokens and recursive (delimiter-free) listing, so it can page
  through a bucket with more than 1000 objects instead of being capped at a
  single page. Each call is still bounded; paging is explicit, never automatic.

### Changed

- **The Agent now self-verifies high-severity conclusions.** Before asserting a
  security exposure, outage cause, or data-at-risk claim, it confirms it with a
  tool; if it can't, it presents the claim as a hypothesis with lowered
  confidence and records the gap rather than stating it as fact.

## [0.19.19] - 2026-06-29

### Fixed

- **"Key saved" no longer lies after the vault migration.** A provider's
  `has_api_key` / `has_access_key` / … flags were derived from the leftover
  reference in SQLite, so after the keychain→vault move (0.19.18) providers
  showed their keys as present even though the secret wasn't carried over — and
  the agent would then fail mid-run. The flags now reflect whether the secret
  actually exists in the vault, so a not-yet-re-entered key correctly shows as
  missing and prompts you to add it.

## [0.19.18] - 2026-06-29

### Changed

- **Secrets moved from the OS keychain to a cross-platform encrypted vault — no
  more repeated authorization prompts.** Because the app is ad-hoc-signed, the
  macOS Keychain re-prompted on every update (and the Linux Secret Service can
  prompt or be missing). Secrets now live in a single AES-256-GCM file whose
  master key is protected by the strongest *non-prompting* mechanism per OS
  (Windows DPAPI; an owner-only `0600` key file on macOS/Linux). The app no
  longer prompts to authorize key access on any platform. *One-time note: after
  updating, re-enter your model API key and cloud credentials once — they aren't
  migrated automatically (migrating would have triggered the very keychain
  prompt we're removing). They're never prompted for again.*
- **Settings polish.** The Providers section header no longer dwarfs the other
  settings sections (consistent type scale); all UI copy uses "Agent" rather
  than the Chinese "智能体".
- **Agent autonomy simplified to two options** — 协助 (Assisted: proposes
  read-only runs to confirm) and 自主 (Autonomous: runs read-only checks itself),
  defaulting to **Autonomous**. Data-moving work still always requires
  confirmation.

### Security

- Secrets are still never written to SQLite, logs, reports, traces, or model
  prompts, and cloud access remains read-only with no write/destructive
  capability. On macOS/Linux the vault's key file sits beside the data with
  owner-only perms (a deliberate local-first tradeoff for prompt-free operation;
  a future Developer-ID signature could re-enable the macOS keychain prompt-free).

## [0.19.17] - 2026-06-29

### Added

- **The agent can now act, not just advise (autonomy policy).** A new setting
  (Settings → Agent autonomy: advisory / assisted / autonomous read-only,
  default **assisted**) lets the in-chat agent EXECUTE read-only runs itself —
  diagnostics, bucket config review, account discovery — and fold the findings
  into its answer, instead of only proposing a form you then drive. The runs are
  real, audited, read-only, and appear in the timeline.
- **The analysis narrator can drill down.** Instead of being frozen to one
  pre-computed view, it can ask bounded follow-up aggregate questions over the
  already-local dataset (e.g. "which prefixes carry the 5xx?").

### Changed

- **Graded list sampling instead of a silent 100-key clamp.** A deliberate
  larger request is honored up to a bounded 1000 (matching the storage layer's
  own cap); only a full scan beyond that needs a confirmed run.

### Security

- **No weakening — the envelope is unchanged and enforced in code, below the
  autonomy setting.** Data-moving work (downloads, large scans, dataset
  analysis) and any mutating op always require confirmation; there is still no
  write/destructive capability anywhere. Drill-down runs only whitelisted
  GROUP BY / COUNT shapes with bound parameters (no free SQL, raw rows, or object
  bodies). The forbidden-tool guard now matches whole name tokens, so legitimate
  read-only tools aren't blocked by an incidental substring while real dangers
  still are.

## [0.19.16] - 2026-06-28

### Changed

- **Keychain access no longer floods you with prompts.** All secrets (model API
  key, cloud access/secret keys, session tokens) are now consolidated into a
  single OS Keychain item instead of one item per secret. macOS prompts **once**;
  picking "Always Allow" then covers every secret the app reads — removing the
  friction that made "secrets only in the Keychain" painful, with no change to
  the guarantee (secrets never leave the Keychain, never touch SQLite/logs/
  reports/model prompts). Secrets stored by older versions are migrated forward
  automatically on first read, so existing keys keep working. (The remaining
  one prompt per app version is inherent to ad-hoc signing.)
- **One model-client builder for every LLM path.** The conversational session
  agent, the agent-planner runs, and the analysis/error-triage narrators now all
  build their model client through a single `agent_service.build_agent` with a
  per-run client, eliminating a process-global SDK client that could race across
  concurrent runs.
- **Run events renamed to mode-neutral names** (`plan`, `summary`,
  `final_summary`, `run_started`, `tool_selected`) so deterministic runs no
  longer emit misleading `agent_*` event names.

### Removed

- Deleted the dead `RunsView` left over from the retired three-column UI.

## [0.19.11] - 2026-06-28

### Changed

- **Reverted the empty-state suggestions to a single row of chips.** A 2×3
  icon-card grid was tried and removed — the chips are cleaner and more
  consistent.

### Fixed

- Documentation: removed stale "first launch ~1 minute" wording (cold start is a
  few seconds since the one-dir sidecar) and brought the changelog and the
  GitHub Release notes up to date with accurate, per-version content.

## [0.19.10] - 2026-06-28

### Added

- **Session search.** A search box in the rail filters chats live by title
  (reveals matching archived chats; clearable; shows a "no matches" state).

### Changed

- **"New chat" restyled** to a quiet rail-consistent row with a `⌘N` shortcut
  hint, matching Codex/Cursor (replacing a bordered pill that clashed with the
  flat list).

## [0.19.9] - 2026-06-28

### Changed

- **License is now Apache-2.0** (added `LICENSE` + `NOTICE`).
- **Positioning broadened** from "diagnostics" to object storage **operations,
  analytics, and management** across README, app metadata, and the first-run
  wizard.
- **Chinese name → 云存储 Agent** (was "存储智能体").
- Minor UI polish: empty-state spacing and an icon-button settings-drawer close.

## [0.19.8] - 2026-06-28

### Fixed

- **Fewer macOS keychain prompts.** The sidecar now caches resolved secrets in
  process (invalidated on save/delete), so the keychain — and its authorization
  prompt — is hit at most once per secret per launch instead of on every agent
  run. Click **Always Allow** once to silence it for a build.

## [0.19.7] - 2026-06-28

### Fixed

- **Cold start cut from ~60s to a few seconds.** The Python sidecar is now built
  as a PyInstaller **one-dir** bundle shipped as a Tauri resource (instead of
  one-file + `externalBin`). One-file self-extracted its whole archive on every
  launch and macOS Gatekeeper re-scanned it each time; one-dir keeps libraries at
  a stable path scanned once. macOS sealing switched to a single deep ad-hoc sign
  (no hardened runtime).

### Changed

- Rewrote README and the `docs/` set for the current shipping state; removed
  stale phase-era docs.

## [0.19.6] - 2026-06-28

### Fixed

- **Session rename / pin / archive were unresponsive.** The sidecar CORS config
  rejected the `PATCH` preflight, so those requests never reached the backend;
  added `PATCH`/`OPTIONS` to the allowed methods.
- Replaced `window.prompt` (rename) and `window.confirm` (delete) — no-ops in the
  Tauri webview — with an inline rename field and an inline delete confirm.
- Removed a redundant brand-mark tile from the empty state.

## [0.19.5] - 2026-06-28

Session management + elegant next-step chips.

### Added

- **Session management.** Each chat in the rail now has a ⋯ menu: **rename**,
  **pin/unpin**, **duplicate (fork)**, **archive/unarchive**, and **delete**.
  Pinned chats sort into a "Pinned" group at the top; archived chats move to a
  collapsible "Archived" section. Fork copies a chat's full message thread into a
  new chat so you can branch a conversation. (New `pinned` column; new
  `DELETE /sessions/{id}` and `POST /sessions/{id}/fork` endpoints.)

### Changed

- **Suggested next steps are now compact chips** (ChatGPT/Cursor-style) instead
  of stacked full-width bordered cards — a subtle "Suggested next steps" label
  followed by small clickable pills. One click still hands the task to the agent
  in the conversation.

## [0.19.4] - 2026-06-28

Icon fix + Linux & Windows installers.

### Fixed

- **App icon showed a white border/card** in Launchpad/Finder. The icon PNG had
  been rasterized onto a white background instead of transparent corners, so
  macOS drew a white square behind the rounded mark. Re-rasterized with proper
  alpha (transparent corners) and regenerated all bundle icons.

### Added

- **Linux (x64 `.deb`) and Windows (x64 NSIS `-setup.exe`) release builds.** The
  release workflow now builds and publishes all three desktop platforms
  (macOS arm64 + Linux + Windows) to one GitHub Release, each with a stable
  asset name and a per-platform `SHA256SUMS-*.txt`. Linux/Windows builds are
  unsigned (Windows may trigger a SmartScreen "unknown publisher" prompt — use
  More info → Run anyway; Linux installs via `dpkg -i`).

### Notes

- Release jobs are decoupled (a `prepare` job creates the release; each platform
  uploads to it), and every platform stamps its bundle version from the tag via
  `scripts/stamp-version.py`. Windows/Linux are still pre-1.0 and unsigned; see
  docs/signing.md for the path to signed/notarized builds.

## [0.19.3] - 2026-06-28

New brand logo + agent-native next steps. Ad-hoc signed (not notarized), macOS arm64.

### Changed

- **New logo** — an object-storage bucket with an agent spark — across the app
  (session rail, empty-state hero) and all bundle icons (dock / Finder / About).
- **Next-step suggestions are now agent-native.** Clicking a suggested step used
  to walk you through "preview → prepare → a full New Run form" (planner mode,
  max-buckets, glob patterns, a prompt field) — the legacy Analysis-Run admin
  flow bolted onto the chat. Now a single click hands the task back to the agent
  in the conversation: it investigates live with its read-only tools and answers
  inline, no modal. Steps that genuinely need an external file (evidence imports)
  still open their purpose-built dialog; reports just render.

### Removed

- The New Run configuration modal from the suggestion handoff, and the redundant
  two-button "preview / prepare" step.

## [0.19.2] - 2026-06-28

Correct version display + documented signing path. Ad-hoc signed (not
notarized), macOS arm64.

### Fixed

- **The app reported version 0.1.0** (e.g. in the About box). The macOS bundle
  version comes from `tauri.conf.json`, not the release tag, and it was never
  updated. Bumped it, and the release workflow now stamps the bundle version
  from the release tag at build time, so the version is always correct.

### Added

- **`docs/signing.md`** — how macOS signing/notarization works here, what a
  comparable app (omni-macos) does (Developer ID + notarytool, $99/yr Apple
  Developer Program), the extra hardened-runtime entitlements our Python sidecar
  needs, and the exact steps + CI secrets to turn on notarized, prompt-free
  releases. Added `scripts/macos-entitlements.plist` scaffolding for that path.
- Clearer first-launch instructions in the release notes (the one-time
  `xattr -dr com.apple.quarantine` / right-click → Open step).

### Notes

- Frictionless (no Gatekeeper prompt) distribution still requires Apple
  notarization, which needs a paid Apple Developer ID — there is no free
  workaround. The pipeline is ready to notarize once those credentials are added
  as CI secrets; until then, builds remain ad-hoc signed with the documented
  one-time open step.

## [0.19.1] - 2026-06-28

Fixes a truncation bug in agent answers. Ad-hoc signed (not notarized), macOS arm64.

### Fixed

- **Long enumerations were silently cut to ~8 rows.** Asking the agent to list
  all buckets (or any long list) returned only the first ~500 characters — a
  96-row table came back as 8 rows, and the agent would even claim the result
  was "truncated by a length limit" or propose re-running the tool. Root cause:
  the chain-of-thought stripper applied to every answer ended with a hard
  `text[:500]` cap, so it — not the documented answer limit — was the binding
  constraint. The stripper now only removes reasoning markers and leaves length
  to the real caps; answer caps were also raised (12000 → 48000 chars) and an
  explicit generous model `max_tokens` is set. The instructions now explicitly
  require complete enumeration. Verified live: "list all my buckets" now returns
  all 96 rows. Regression tests added.

## [0.19.0] - 2026-06-28

First formal (non-prerelease) release of the 0.19.0 line. Adds full multi-language
support and a light theme. Ad-hoc signed (not notarized — Gatekeeper still
requires a right-click → Open on first launch), macOS arm64.

### Added

- **Multi-language UI (English + 简体中文).** A dependency-free i18n layer with a
  language switcher in Settings → Appearance. Language is auto-detected from the
  OS on first run and remembered per device. The whole product surface is
  localized — session rail, the thread (greeting, composer, suggestions, slash
  commands, tool/run/triage/proposal cards, errors), command palette, first-run
  wizard, and the full model/cloud provider settings — and the suggestion prompts
  themselves localize so a Chinese user sends Chinese.
- **Light theme.** A second theme alongside dark, switchable in Settings →
  Appearance and remembered per device (applied before first paint, no flash).
  All surfaces, the accent, and the neutral text ramp are driven by CSS variables
  so both themes stay consistent across every screen.

### Notes

- This is a formal release, but signing is unchanged from the pre-releases:
  **ad-hoc signed, not Apple-notarized.** First launch: right-click the app →
  Open (or allow it in System Settings → Privacy & Security), then it opens
  normally. The bundled sidecar is validated on first extraction, so first launch
  can take up to ~1 minute.
- A few deep, rarely-used flows (the new-run form, evidence-import dialog,
  account-profile panel, run transcript) are not yet localized; the i18n layer is
  in place to extend them.

## [0.19.0-pre.9] - 2026-06-28

A Codex/Cursor-grade start view and agent-driven next steps. Ad-hoc signed
(not notarized), pre-1.0, macOS arm64.

### Changed

- **New-chat view rebuilt as a centered, composer-forward "start" screen**
  (Codex/Cursor): the composer is the centerpiece — greeting above, suggestion
  chips below — instead of a greeting at the top with the composer pinned to the
  bottom over an empty void. In an active conversation the composer drops to the
  bottom and turns scroll above it.
- **Composer refined** to match the references: a model-picker pill (with
  chevron), `⏎ send · ⇧⏎ newline` hints, and a circular send button that fills
  with the accent only when there's text.

### Fixed

- **Next-step proposals are now agent-driven, not canned.** A generic
  "Run account discovery" chip used to reappear after *every* answer when the
  agent itself proposed nothing — even after a one-line definitional reply. The
  thread now shows the agent's own proposals once it has answered, and only
  falls back to the session's default next steps before the first turn.

## [0.19.0-pre.8] - 2026-06-28

Skills become real Agent Skills. Ad-hoc signed (not notarized), pre-1.0,
macOS arm64.

### Changed

- **Skills now follow the Agent Skills paradigm (progressive disclosure).** The
  agent's context carries a compact catalog (name + description for all 16
  StorageOps skills); it loads a skill's full method on demand via a new
  read-only `read_skill` tool — instead of a keyword matcher pre-stuffing full
  skill bodies into every prompt. The model chooses; context stays lean.
- **Removed the self-contradictory "tools/scripts disabled" skill wrapper.** It
  pre-dated the tool-using agent and told it not to do what it now does.
- **Rewrote all 16 SKILL.md bodies + the registry to be app-native.** They were
  written for a different runtime (helper scripts, `references/` files, foreign
  tools, a foreign output contract). Each now keeps its decision tree but maps
  its workflow to the agent's real read-only tools (`test_credentials`,
  `head_object`, `test_addressing_style`, `inspect_endpoint_tls`,
  `review_bucket_*`, …) and confirmed runs, and reports facts-vs-inference like
  the rest of the app.

### Fixed

- Frontmatter trimmed to `name` + `description`; dropped `recommended_tools`,
  `estimated_tokens`, and other foreign-runtime metadata. A guard test now fails
  the build if foreign-runtime artifacts reappear in the pack.

## [0.19.0-pre.7] - 2026-06-27

A more capable agent and a markdown-grade thread. Ad-hoc signed (not
notarized), pre-1.0, macOS arm64.

### Changed

- **The chat agent gets the full read-only diagnostic toolset.** It called
  itself a diagnostician but could only list/head/review; it can now also run
  `test_credentials` (auth/403 root cause), `head_object` (per-key
  metadata/404), `test_range_get` (range support/latency), `test_addressing_style`
  (virtual-hosted vs path-style — SignatureDoesNotMatch / endpoint), and
  `inspect_endpoint_tls` (TLS handshake/expiry), plus the
  `review_bucket_performance_profile` review that was missing from chat. It
  chains probes across up to 16 turns (was 8). Every tool stays read-only,
  scoped, bounded, audited, and secret-safe.
- **Markdown answers rendered to Codex/Cursor grade.** Horizontal rules now
  render as dividers (were literal `---`), plus blockquotes, links, italics,
  refined tables (uppercase headers, zebra rows) and heading rhythm. Tool-trace
  rows stay on one line with truncation so long bucket names don't wrap.

### Fixed

- Sending the first message in a new chat no longer flashes the empty state —
  the optimistic user turn + thinking/streaming bubble is preserved when the
  session is created mid-send. Next-step proposals are hidden while a turn is in
  flight.

## [0.19.0-pre.6] - 2026-06-27

Streaming agent answers. Ad-hoc signed (not notarized), pre-1.0, macOS arm64.

### Added

- **Streaming chat (SSE).** The agent's turn now streams live: read-only tool
  traces appear as they run and the answer types in token-by-token, with a
  caret while it writes (Codex/Cursor-style). New endpoint
  `POST /sessions/{id}/messages/stream`.
- **Automatic, lossless fallback.** Some OpenAI-compatible providers (notably
  DeepSeek) mishandle streaming when a turn makes tool calls and abort mid-stream;
  on any stream error the client transparently falls back to the blocking turn,
  so the answer is always correct. The stream endpoint persists nothing until it
  completes, so the fallback never duplicates the turn. Explanatory (no-tool)
  answers stream end-to-end on all providers.

### Fixed

- Parallel tool calls are disabled for streaming runs, which avoids a class of
  malformed follow-up messages with chat-completions providers.

## [0.19.0-pre.5] - 2026-06-27

The in-chat agent becomes a real agent. Ad-hoc signed (not notarized),
pre-1.0, macOS arm64.

### Changed

- **The chat agent now investigates live.** It was interpretation-only (no
  tools); it now uses read-only tools — `list_providers`, `list_buckets`,
  `head_bucket`, bounded `list_objects`, `get_bucket_config_summary`, and
  `review_bucket_*` — choosing the provider/bucket itself and answering from
  real results (e.g. "列出我的 bucket" lists them directly). All guardrails
  remain: no destructive/mutating operations exist, scans are bounded, every
  call is audited, credentials stay in the OS keychain and never reach the
  model, and anything that moves data or runs a large/analysis job stays a
  confirmed run.
- **Inline tool-call transparency** (Codex/Cursor-style): each answer shows the
  read-only tools it ran, e.g. `list_buckets · Baidu BOS → 96 buckets`,
  persisted with the message.
- One-pick cloud setup, ⌘K palette, slash commands, live "thinking" state, and
  richer markdown (carried from pre.4 line).

### Fixed

- Next-step proposals are actionable: `prepare` falls back to the configured
  provider (auto-binds the only one) and run proposals always open the run form.
- Stray green focus ring recolored to the indigo accent; composer double-ring
  removed; model chip refetches when the sidecar connects.
- Provider auth/404 failures no longer show "Add a model API key"; they show an
  actionable message with an Open settings action.

## [0.19.0-pre.4] - 2026-06-27

Restores agent mode in the packaged app and adds Codex/Cursor-style
interactions. Ad-hoc signed (not notarized), pre-1.0, macOS arm64.

### Fixed

- **Agent mode was broken in the packaged app** ("OpenAI Agents SDK is not
  available in this environment"). The PyInstaller spec listed `agents` /
  `openai` as bare hidden imports, which isn't enough — they import submodules
  at import time, so the one-file bundle failed to load them (dev worked because
  the venv had everything). The spec now collects `agents`, `openai`, and
  `griffe` in full. Verified on a freshly built bundle.
- Provider auth/404 failures no longer show "Add a model API key" (which implied
  none was configured). The needs-key prompt fires only on the real "no model
  provider configured" case; other failures show an actionable message with an
  Open settings action.

### Added

- **⌘K command palette** — quick-switch chats, New chat, Settings; type-to-filter
  with arrow/enter/esc. Global shortcuts ⌘K, ⌘N (new chat), Esc (close overlays).
- **Composer slash commands** — `/` opens a menu: `/diagnose`, `/logs`,
  `/inventory`, `/config`, `/account`, `/optimize` seed a prompt; `/report`
  generates the chat report.
- **Live "agent is working" state** — the user turn appears instantly and an
  animated indicator with rotating status replaces the send spinner until the
  reply lands.
- **Richer markdown** in agent replies — fenced code blocks with a language label
  and Copy button, headings, tables, lists; plus a hover Copy on agent messages.

## [0.19.0-pre.3] - 2026-06-27

UI/UX pass toward Codex/Cursor conventions, plus simpler cloud setup.
Ad-hoc signed (not notarized), pre-1.0, macOS arm64 primary target.

### Changed

- Dropped "investigation" terminology — it's "New chat" / "Recent" / chat now.
- Rail: flat brand mark, quiet New-chat row, recent list with a left accent bar
  on the active chat + relative time, compact status + settings footer.
- Thread: slim header with the chat title and a model badge (shows the configured
  provider model); a fresh chat shows just the canvas and composer.
- Messages: user turns are a subtle right-aligned bubble; agent turns are clean
  labeled prose (markdown). Runs are collapsible tool-call blocks, triage is a
  tool-style block, and next-step proposals are light action chips.
- Composer (Cursor-style): a rounded panel with a model chip and send row.
- **One-pick cloud-provider setup.** Choosing a provider (AWS S3, Alibaba OSS,
  Tencent COS, Baidu BOS, Volcengine TOS, Cloudflare R2, Backblaze B2, Google
  Cloud Storage, or Custom) fills in endpoint / addressing / signature; you enter
  region (or the R2 account id) plus access key + secret key. Endpoint override,
  addressing, signature, session token, mode, and bucket/prefix allowlists move to
  a collapsed Advanced section. Provider-panel copy is now English throughout.

### Notes

- After configuring read-only S3 credentials, the agent can enumerate the
  account's buckets and snapshot each bucket's configuration (account discovery),
  then review security / lifecycle / cost / performance per bucket — listing all
  buckets requires the `s3:ListAllMyBuckets` permission.

## [0.19.0-pre.2] - 2026-06-27

Second pre-release; supersedes the withdrawn v0.19.0-pre.1. Ad-hoc signed
(not notarized), pre-1.0, macOS arm64 primary target.

### Changed

- **Rebuilt the desktop UI into a thread-first agentic workbench (Codex/Cursor
  style).** A single conversation thread with a slim session rail and **one
  unified composer** — the agent routes intent; offline error triage is an
  automatic fallback, not a separate mode. Tool runs, triage cases, and
  next-action proposals render as inline cards; nothing runs without
  confirmation.
- Reframed the product around the agent's **full capability surface** — diagnose
  errors, analyze access logs, inventory & capacity, review bucket configuration,
  map the account, and find optimizations — rather than error triage alone. A
  capability-forward empty state seeds the composer.
- First-run wizard → inline settings drawer for model- and cloud-provider setup.
- Refined the visual language to a **near-monochrome dark palette** with a single
  restrained accent, flat marks, hairline borders, and markdown agent answers.
- Retired the previous tabbed admin-panel shell (Home / Sessions / Providers /
  Runs / Datasets / Reports nav, sidebar, context panel).

### Fixed

- **macOS bundle "app is damaged" / broken code-signature seal.** The build now
  ad-hoc seals the `.app` after bundling (`scripts/sign-macos-app-bundle.sh`),
  rebuilds the DMG from the sealed app, and gates on `codesign --verify --deep
  --strict`. Sealing intentionally does **not** enable the hardened runtime —
  under it the PyInstaller Python sidecar can't load its bundled framework and
  never starts.
- **Third-party OpenAI-compatible model providers (e.g. DeepSeek) now work.** The
  agent honors the provider `base_url` with the Chat Completions API; the SDK's
  trace upload to OpenAI is disabled.
- First-message next-action proposals were dropped on a new investigation.
- Removed stale "Phase 01 / bootstrap only" copy.

### Security

- Secrets stay in the OS keychain / keyring; never in SQLite, logs, reports, or
  model prompts.
- The agent no longer uploads traces or prompts to OpenAI's tracing backend.
- Read-only S3 by default; no destructive operations; bounded, sanitized agent
  context; chain-of-thought not persisted.

### Notes

- **v0.19.0-pre.1 was withdrawn** after product smoke: the UI was not yet a
  usable agent-first workbench and the macOS seal was broken. Both are fixed here.
- **First macOS launch is slow (up to ~1 min):** macOS validates the freshly
  ad-hoc-signed one-file sidecar on first extraction; later launches are fast. The
  window shows "Sidecar: Connecting" until ready.
- Notarization / Apple Developer ID signing remain out of scope for these
  pre-1.0 builds.

## [0.19.0-pre.1] - 2026-06-27 [WITHDRAWN]

Withdrawn after product smoke failed (see Unreleased → Notes). Unsigned, pre-1.0,
macOS arm64.

### Added

- Local-first desktop Storage Agent Workbench through Phase 19.
- Read-only S3-compatible diagnostics.
- Account discovery and bucket configuration review.
- Managed evidence import for inventory and access logs (plan → confirm → run).
- DuckDB-based inventory and access-log analysis.
- Session-centered investigation workspace.
- Safe next-action handoff (review → prepare → confirm).
- S3 / object-storage error triage assistant.
- Bundled StorageOps skills-only context injection.
- Markdown reports.

### Security

- Secrets stay in the OS keychain / keyring.
- No plaintext secrets in SQLite, logs, reports, or model prompts.
- No generic shell or arbitrary subprocess.
- No destructive S3 operations.
- No StorageOps tools/scripts imported or executed.
- No public skill API.
- Agent context is bounded and sanitized.
- Chain-of-thought is not persisted.

### Packaging

- macOS arm64 unsigned desktop build path.
- Linux x64 and Windows x64 experimental CI builds.
- Manual `workflow_dispatch` GitHub Release workflow added for pre-release
  publication (no signing, no notarization).

[Unreleased]: https://github.com/hxddh/storage-agent-workbench/compare/v0.19.11...HEAD
[0.19.11]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.11
[0.19.10]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.10
[0.19.9]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.9
[0.19.8]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.8
[0.19.7]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.7
[0.19.6]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.6
[0.19.5]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.5
[0.19.4]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.4
[0.19.3]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.3
[0.19.2]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.2
[0.19.1]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.1
[0.19.0]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.0
[0.19.0-pre.9]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.0-pre.9
[0.19.0-pre.8]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.0-pre.8
[0.19.0-pre.7]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.0-pre.7
[0.19.0-pre.6]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.0-pre.6
[0.19.0-pre.5]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.0-pre.5
[0.19.0-pre.4]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.0-pre.4
[0.19.0-pre.3]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.0-pre.3
[0.19.0-pre.2]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.0-pre.2
[0.19.0-pre.1]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.0-pre.1
