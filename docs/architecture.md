# Architecture

## Overview

Storage Agent Workbench is a local-first desktop app.

Architecture:

```text
Tauri desktop shell
  ↓
React / Vite / TypeScript frontend
  ↓
Python FastAPI sidecar
  ↓
Agent runtime and whitelist tool layer
  ↓
SQLite / DuckDB / encrypted secret vault / local files
```

## Tauri

Tauri is responsible for:

- Desktop shell
- Launching the sidecar
- Packaging
- Local desktop integration

Tauri is not responsible for:

- Agent logic
- S3 logic
- Analysis logic
- Secret processing

## Frontend

A thread-first agentic workbench (Codex/Cursor-style) built with React + Vite +
TypeScript + Tailwind:

- Session rail (new investigation; rename / pin / archive / delete / fork).
- Conversation thread with a sticky composer; runs, error-triage cases, and
  proposed next actions render as inline cards. Only user/deterministic runs card
  in the thread — the agent's own inline surveys/reviews (`origin === 'agent'`)
  are filtered out; the agent narrates their result in prose instead.
- Answers render through a dependency-free markdown renderer with syntax
  highlighting and table-derived charts (see "Rendering an answer").
- Settings drawer for model/cloud providers; first-run wizard.
- Tool timeline, findings, and report preview inside run cards.
- Dark/light themes and English/中文.

## Sidecar

The Python FastAPI sidecar provides the local API:

- Health check and SSE streaming (with a blocking fallback).
- SQLite metadata; secrets in an encrypted local vault (only `keyring://`
  references in SQLite).
- Read-only S3 / S3-compatible diagnostic tools.
- DuckDB analysis for inventory and access logs.
- The conversational session agent (OpenAI Agents SDK) and report generation.

## Storage responsibilities

SQLite stores application metadata:

- Providers
- Runs
- Messages
- Tool calls
- Audit logs
- Approval events
- Dataset metadata
- Report metadata

DuckDB stores analytical data:

- Access logs
- Inventory files
- Sampled object metadata
- Derived metrics

The encrypted secret vault (`security/keyring_store`) stores secrets:

- Model API keys
- Cloud access keys
- Secret keys
- Session tokens

All secrets live in a single AES-256-GCM file (`secrets.enc`) in the app data
dir; the 32-byte master key is protected by the strongest *non-prompting*
mechanism per OS (Windows DPAPI; an owner-only `0600` key file on macOS/Linux).
This is deliberately not the OS keychain — the app is ad-hoc-signed and
cross-platform, where the keychain re-prompts on every update (macOS) or may be
absent/prompts on headless Linux. SQLite holds only `keyring://scope/name`
references; secrets never appear in SQLite, logs, reports, traces, or LLM
prompts. See [security.md](security.md).

Local files store:

- Raw uploaded files
- Run artifacts
- Markdown reports
- DuckDB files

## Local API

Default sidecar URL:

```text
http://127.0.0.1:8765
```

Health check:

```text
GET /health
```

The sidecar exposes routers for model/cloud providers, S3 diagnostic tools,
runs, evidence imports, sessions, and reports. See [api.md](api.md).

## Streaming

Run events and session agent turns stream over Server-Sent Events, with a
blocking fallback when SSE is unavailable. WebSocket is intentionally not used.
Each streaming agent turn is tracked in an in-process turn registry keyed by the
client `turn_id`: `POST /sessions/{id}/turns/{turn_id}/cancel` stops the turn
mid-flight (the partial answer is persisted with a stopped marker, and the SSE
`done` event may carry `stopped: true`), and a blocking request for an
already-in-flight `turn_id` waits for that turn instead of re-running the agent
(409 after ~150 s). See [api.md](api.md).

## Account discovery

The `account_discovery` run type builds an account-level asset picture from
read-only APIs:

    test_credentials → list_buckets → (per visible bucket, bounded by
    max_buckets) head_bucket + bucket config snapshot + evidence-source
    discovery → account profile + report.

- **`list_buckets`** (`s3/tools.py`) is the only listing performed — a read-only
  ListBuckets. It never calls ListObjectsV2 and never touches object bodies.
  Capability/permission gaps map to `provider_unsupported` / `access_denied`.
- **`account_tools.get_bucket_config_snapshot`** reuses the read-only
  config readers to produce per-bucket status enums (available / not_configured
  / provider_unsupported / access_denied / error) for versioning, encryption,
  lifecycle, logging, replication, policy, public-access-block, tagging,
  inventory.
- **`account_tools.discover_evidence_sources`** discovers *whether* inventory
  and server-access-logging are configured (and their destinations) — it never
  pulls a full inventory report or access log. CloudTrail / Storage Lens /
  provider access logs are reserved and reported as `not_implemented`, never
  faked as supported.
- The executor (`runs/account_discovery_run.py`) is deterministic only. It is
  bounded by `max_buckets` (default 100, hard cap 500) with optional
  include/exclude glob patterns; each bucket's reads are isolated so one
  bucket's failure never fails the whole run.
- **Probing is concurrent; recording is not.** Per-bucket probing is
  network-bound, so it runs in a small bounded pool (4 workers) where each
  worker holds its own sqlite connection and uses it purely to read the provider
  row and build the (globally cached, request-thread-safe) boto3 client. Every
  database write, `tool_call`/audit row, and SSE event still happens on the run
  thread, **sequentially, in the original bucket order** — so the per-bucket
  transaction isolation and the recorded ordering are exactly what they were
  when probing ran inline. A probe that fails is captured per bucket and
  re-raised on the run thread, producing the same error row. The true elapsed
  time is threaded into `run_tool` (`duration_ms`) so an audit row never claims
  ~0 ms for work that took seconds. The worker count is deliberately small: a
  wide fan-out invites provider-side `SlowDown` throttling. Results persist to four SQLite
  tables (account_snapshots, account_snapshot_buckets, bucket_config_snapshots,
  evidence_sources) via `repositories/account_discovery.py`, all JSON
  redaction-passed. `GET /runs/{id}/account-profile` returns the structured
  profile the UI renders as a filterable bucket table.
- `account_discovery` is deterministic — no bucket list or config JSON is ever
  sent to an LLM. The conversational agent triggers it through its read-only
  `survey_account` tool and narrates only the sanitized summary + counts.

## Next-action handoff

A next-action proposal is a *suggestion*, never automation. The agent is the sole
driver: most proposals are simply handed back to it to carry out with its
read-only tools; only genuinely-confirmed data-moving work gets a purpose-built
flow.

- **Normalized proposals** (`sessions/next_actions.py`): every proposal is
  coerced to a canonical, sanitized shape (`id`, `title`, `reason`,
  `action_type`, `requires_confirmation=true`, `confidence`, `source_run_ids`,
  `prefill`, `safety_notes`, `status`). `action_type` is **free-form** (the agent
  proposes any concrete next step in its own words), sanitized to a bounded slug;
  a forbidden/destructive token (shell/exec/sql/delete-object/put-bucket-policy/…)
  is dropped. A small set of `SPECIAL_ACTION_TYPES` gets a purpose-built flow (see
  below); everything else routes back to the agent conversationally.
- **Prepare** (`POST /sessions/{id}/actions/prepare`) ONLY validates + prefills.
  It never creates a run, downloads evidence, confirms an import, calls S3, or
  calls an LLM. It returns which flow to `open` for the three special cases —
  `evidence_import` (a confirmed cloud import), `session_report` (the saved
  report), `message_composer` (a context question) — or `open=None` for
  everything else, which the UI hands back to the agent. (There is **no**
  `new_run` form and no `preview` endpoint; both were retired.)
- **Agent does it itself, no run card:** investigation, diagnosis, config review
  (`review_bucket_config`), account survey (`survey_account`), and **uploaded-file
  analysis** (`analyze_uploaded_file`) are all things the conversational agent
  performs with its own read-only tools (`agent_runtime/session_action_tools.py`,
  `session_analysis_tools.py`). The heavier survey/review tools run the
  deterministic engine and persist a profile, but the run is recorded with
  `origin='agent'` and is **never shown as a structured run card** — the agent
  narrates the result inline. Only an explicit, user-requested auditable report
  surfaces as a card.
- **Confirmed data-moving only:** cloud evidence import (`EvidenceImportDialog`,
  plan → confirm → run) and large/full scans always remain confirmed proposals —
  the agent never auto-runs them. A file the user *attached* is local, so the
  agent analyzes it inline without a confirmation step.
- **Assistant proposals:** the session agent may additionally return a
  fenced-JSON `proposed_actions` block; the backend sanitizes each the same way
  (forbidden tokens dropped, `requires_confirmation` forced).
- **Audit:** `next_action_prepared` / `next_action_opened` — lightweight events,
  not a task lifecycle (no assignee/status-board/ticket state).

## StorageOps skill context injection

The existing Agents gain **professional-method context** from the bundled
StorageOps skill pack — skills-only, guidance-only. It is NOT a skills platform:
no StorageOps tools, helper scripts, CLI, Pi runtime, subprocess, MCP,
multi-agent runtime, skill API, skill UI, skill DB tables, or RAG.

- **Vendored** under `sidecar/app/bundled_skillpacks/storageops/`: only
  `skill-registry.yaml` + `skills/*/SKILL.md` (20 skills). No `references/`,
  `templates/`, `scripts/`, `storageops_cli/`, or `extensions/` are copied.
- **`skills/loader.py`** parses minimal registry metadata (name / path /
  description / maturity / mode / trigger_keywords / domains / auto_route) and
  loads SKILL.md bodies. `recommended_tools` is deliberately NOT exposed — never
  registered, shown, or executed. (`trigger_keywords` / `domains` / `auto_route`
  are parsed but currently **unconsumed** — no offline selector reads them;
  `description` is the only routing signal the live agent sees.)
- **Progressive disclosure (the live mechanism)**: `skills/context.py` exposes
  `catalog_text()` — the always-in-context list of skill `name + description` —
  and `read_skill_text(name)`, which returns one SKILL.md body, frontmatter-
  stripped and length-bounded (no wrapper preamble). `agent_runtime/session_agent.py`
  injects the catalog and the agent calls the read-only `read_skill` tool on
  demand for the skills it judges relevant — there is no eager 1–3 skill
  pre-selection in the live path, and there is no lexical `selection.py` (it was
  removed; the catalog + agent-chosen `read_skill` is the whole mechanism).
- **Contract**: the agent emits a minimal contract via `skills/contract.py`:
  `{answer, skills_used, evidence_used, evidence_gaps, next_action_proposals}` —
  answer redacted + CoT-stripped, `skills_used` limited to skills actually loaded
  via `read_skill` this turn, proposals sanitized (forbidden tokens dropped). The raw
  error blob / secrets / chain-of-thought never reach the model. Deterministic
  triage (or a missing model key) does not fabricate a skill-grounded diagnosis.
- No migration / DB table / public skill API was added; skill-grounded fields
  ride existing session-message responses and the triage case JSON, and the
  session report lightly absorbs `skills_used` / `evidence_gaps` when present.

## Error triage assistant

A session-centered capability to triage S3 / object-storage / S3-compatible
errors — NOT a static FAQ or error-code dictionary page.

    paste error -> redact -> deterministic parse -> playbook match ->
    candidate causes + evidence + next checks
    -> sanitized triage case + next-action proposals

- **`error_triage/parser.py`** extracts bounded signals (error code, HTTP
  status, region, endpoint, bucket, operation, language, TLS/connection/pagination
  flags) from an ALREADY-REDACTED blob. It calls no LLM and no S3, and preserves
  uncertainty. `redact_input` runs the shared redactor plus triage-local extras
  (SigV4 `Signature=`/`Credential=`, cookies, secret/session/api-key `k=v`,
  `sk-` model keys).
- **`error_triage/playbooks.py`** is a small curated rule set (not a dictionary):
  per category it gives likely causes, evidence to check, safe read-only next
  checks, related run types, and provider caveats.
- **`error_triage/engine.py`** runs deterministically: parse → match → candidate
  causes + safe next checks + next-action proposals (sanitized via
  `normalize_proposal`). It performs NO S3 call, run, download, or mutation.
  Triage is **deterministic-only** — there is no in-run triage LLM narrator (the
  conversational agent interprets the case if the user asks). The model never
  sees the raw blob or any secret.
- **API**: `POST /error-triage`, `GET /error-triage/{id}`,
  `GET /sessions/{id}/error-triage`. A case binds to its session and the session
  summary is refreshed; cases also appear in the session report's Error triage
  section. Next actions are the proposals — the user reviews/prepares them.
- Persistence (`error_triage_cases`, `error_triage_findings`) stores only the
  redacted input + sanitized parsed signals/findings — never raw sensitive logs,
  secrets, or chain-of-thought. This is not a ticketing system.

## Session-centered agentic workbench

The product is a **session-centered agentic workbench**, not a cloud-management
dashboard or project tracker. The flow is **agent-first** — the conversational
agent drives, calling read-only tools inline and, only when a heavy/auditable
artifact is warranted, invoking a deterministic run:

    Goal → Agent (inline read-only tools) → [optional artifact run] → Findings → Next actions → Report

Runs are the **auditable/security floor beneath** the agent, not a pipeline the
user navigates. The older "Goal → Evidence → Runs → …" phrasing described a
runs-first product that no longer exists.

- **Session** = persistent working context (`sessions`). A run is an auditable
  execution unit; evidence is the factual base; findings are evidence-driven
  conclusions; the Agent interprets, attributes, and proposes next steps.
- **Linkage:** a run carries an optional `session_id` (linked into `session_runs`
  at create time and after completion). `run_service` refreshes the owning
  session's summary when a run finishes — session bookkeeping never fails a run.
- **Deterministic summary** (`sessions/summary_builder.py`): rebuilds, from
  already-sanitized run artifacts (run_type/status/final_summary, sanitized
  tool_call outputs, the persisted account profile), a bounded set of known
  facts, findings (each referencing a `source_run_id`, classified fact /
  inference / suggestion with high/medium/low confidence), open questions, and
  next-action **proposals**. It reads no raw logs/rows, no secrets, and calls no
  LLM. Results persist to `session_findings`, `session_evidence_refs`,
  `session_summaries`.
- **Conversational session agent** (`agent_runtime/session_agent.py`,
  `SESSION_LOOP` seam): the primary surface, a genuine tool-calling loop. The
  deterministic summary is built first for grounding; the agent then investigates
  LIVE with **read-only** tools (`agent_runtime/session_tools.py`: list_buckets,
  head_bucket, bounded/paginated list_objects, list_object_versions,
  list_multipart_uploads, head_object, get_object_lock_status, test_credentials,
  test_addressing_style, inspect_endpoint_tls, test_range_get, preview_object
  (bounded ≤1 MiB text preview), measure_request_latency (bounded latency probe),
  the `review_bucket_*`/`get_bucket_config_summary`/`get_bucket_config_detail`
  config readers, and `read_skill` for progressive-disclosure StorageOps skills),
  chooses
  provider/bucket itself, and grounds its answer in tool output. It has **working
  memory** (`session_agent_memory` table via `session_memory_tools.py`):
  `note_fact` / `record_finding` / `note_open_question` persist sanitized, audited
  items that are fed back into later turns. It self-verifies high-severity
  conclusions with a tool before asserting them. It may also EXECUTE read-only
  runs itself (survey/review — see below). What it still cannot do: bulk-download
  object bodies (the sole bounded exception is `preview_object` / `test_range_get`
  — a single sanitized, per-turn-budgeted read, never a full or recursive
  download), mutate anything, run free SQL/shell, reach any destructive S3 op, or
  see any secret — credentials are resolved server-side inside the S3 layer and
  never enter the model context. Output is redacted + chain-of-thought-stripped +
  bounded; a missing model key fails cleanly (422) and never affects the
  deterministic summary.
- **Next actions** are proposals only (`requires_confirmation: true`); the user
  acts. They are not a task list / kanban / ticket queue.
- **Reports** (`sessions/session_report.py`): goal, executive summary, evidence
  used, run timeline, key findings, confidence/limitations, recommended next
  actions, appendix of linked runs — secret-free, no raw content.
- **Not** a CMDB, monitoring wall, ticketing/kanban/PM system, object browser,
  or multi-user/permission surface. No such tables or endpoints exist.

## Agent autonomy

**There is no autonomy toggle.** The conversational agent is always a fully
autonomous read-only investigator: it runs its read-only tools (S3 probes,
config review, account survey, uploaded-file analysis) on its own and narrates
the result. The security tiers are enforced in code and do not depend on any
setting.

What is *never* auto-run, regardless: `EXPENSIVE`/data-moving work — cloud
evidence import/download and large/full bucket scans — and any `MUTATING` op.
Those stay confirmed proposals, and there is no write/destructive tool in the
product at all. A file the user *attached* is local, so analyzing it inline is
not data-moving and needs no confirmation. The agent's own surveys/reviews run
the deterministic engine but are recorded `origin='agent'` and never surface as a
structured run card (see "Next-action handoff").

## Managed evidence import

Connects account_discovery to the DuckDB analysis path,
under a bounded, confirmation-gated flow:

    discover inventory/logging source → plan → (explicit) confirm → run
    (download evidence files only) → existing inventory_analysis /
    access_log_analysis.

- **Endpoints** (`routers/evidence_imports.py`): `POST /evidence-imports/plan`,
  `GET /evidence-imports/{id}`, `GET /evidence-imports/{id}/files`,
  `POST /evidence-imports/{id}/confirm`, `POST /evidence-imports/{id}/run`.
- **Source validation:** a plan request names an account_discovery run + bucket
  + source type; the server resolves the *discovered* evidence destination from
  the persisted evidence source (inventory destination bucket/prefix or
  server-access-logging target bucket/prefix). The caller cannot point the
  import at an arbitrary bucket/key.
- **Planning** (`evidence/managed_import.py`): inventory planning prefers a
  `manifest.json` (parses `files`, `fileFormat`, `fileSchema`) and falls back to
  a bounded prefix listing of the destination only; ORC is
  `detected_but_not_supported` (CSV/Parquet supported). Access-log planning
  requires a time range and does a bounded listing of the logging target prefix,
  filtering by LastModified. Both bound selection by `max_files` (default 1000,
  hard cap 5000) and `max_bytes` (default 1 GiB, hard cap 5 GiB).
- **Confirmation:** nothing downloads until `confirm`, which records an
  `approval_events` row + audit log. `run` downloads ONLY the confirmed evidence
  files (re-enforcing the byte/file budget via `get_object`), combines them into
  a single local file under the new analysis run's data dir, registers a dataset
  (`name = managed_evidence_import`), and hands off to the existing deterministic
  executor. No business bucket is listed, no business object body is downloaded,
  nothing is mutated.
- **Persistence** (`repositories/evidence_imports.py`, migration 007): tables
  `evidence_imports` + `evidence_import_files`, redaction-passed (bucket/prefix/
  key/warnings) — never secrets.

## Runs are pure deterministic compute

Runs have **no LLM planner and no in-run narrator** — this was the dual-track
design removed in v0.20.0. `run_service.run_sync` always dispatches `run_type`
to its deterministic executor (`_EXECUTORS`); there is no `planner_mode` branch
and no second tool-calling agent. Each executor (`diagnostic`,
`account_discovery`, `bucket_config_review`, `access_log_analysis`,
`inventory_analysis`) runs rule-based compute over the whitelisted read-only S3
layer / local DuckDB engine and emits a real tool trace, findings, and a
sanitized summary. It writes no agent-authored prose section; the vestigial
`runs/planner.py` module is deleted and diagnostic reports carry no canned
"Plan" section — only the real tool trace.

The conversational session agent is the sole LLM. It invokes these executors as
tools (`survey_account`, `review_bucket_config`, `analyze_uploaded_file`) and
narrates their sanitized results in its own words; it reads a backgrounded run's
result later with `read_run_result`. Executors are mockable so tests run without
the OpenAI Agents SDK or an API key; a missing model key fails only the
conversational turn (422) and never affects a deterministic run.

The `runs.planner_mode` SQLite column is retained (defaulting to
`'deterministic'`) only because the schema is append-only — it is no longer read
or written by any code path.

## Packaging & desktop integration

- The Python sidecar is bundled with PyInstaller (`sidecar/packaging/`) into a
  one-dir executable, `storage-agent-sidecar`.
- The Tauri v2 shell launches the bundled sidecar as a child process on a free
  localhost port, passes `STORAGE_AGENT_DATA_DIR` (the OS app-data dir), and
  terminates it on app exit. It does **not** expose the URL until the process on
  that port has echoed a per-launch identity nonce on `/health` — see
  [security.md](security.md) for why that check exists — and a second launch
  focuses the running window instead of starting a second sidecar over the same
  data dir.
- Dev mode runs the sidecar separately; the frontend resolves the URL from
  `VITE_SIDECAR_URL` (dev) or the Tauri command (prod), with a localhost
  fallback. The only spawned process is the internal sidecar — there is no
  user-facing shell/subprocess tool.
- See `docs/packaging.md`. Rust toolchain is required for the desktop build.

## Session observability

Every tool call, audit event, and turn belonging to a session is retrievable
from the session (v0.45.0). This closed a real gap rather than adding a feature:
rule 17 requires that tool calls and approvals be recorded, and they were — but
`tool_calls` and `audit_logs` had no `session_id`, so a conversational turn's
rows were only reachable by `run_id`, and an agent turn has no run. The trail was
written and immediately orphaned.

- **Writes.** The session agent's tool wrapper records a `tool_calls` row per
  call — sanitized input/output, status, measured duration — and stamps
  `session_id` on both that row and its audit event. The recording is wrapped so
  a bookkeeping failure can never break a turn.
- **Reads.** `repositories/session_activity.py` is read-mostly and bounded (500
  rows per request); every response reports its own truncation. It re-derives
  nothing — the rows were sanitized on write, so the inspector is a reader, not
  a second source of truth.
- **Turn metrics.** `turn_metrics` holds one row per turn: wall-clock duration,
  completed tool calls, model, and token counts. Token columns are **NULL** when
  the provider did not report usage — distinct from a measured zero, because a
  fabricated 0 would be a false claim about spend. Nothing is ever estimated.
- **Token capture.** The Agents SDK only requests streamed usage for the official
  OpenAI client, so `ModelSettings.include_usage` is set explicitly for custom
  `base_url` endpoints. An endpoint that rejects the parameter is remembered per
  `base_url|model` and never asked again; that turn recovers through the normal
  finalize pass. Usage is summed across both model runs in a turn (tool loop +
  finalize), because the turn paid for both.

Retention is owner-aware: the startup sweep ages out `tool_calls` only when
they have **neither** a run nor a session (ad-hoc probes, unreachable forever).
Matching `run_id IS NULL` alone — which is what it did before v0.47.0 — also
described every conversational tool call from v0.45.0 onward, and silently
destroyed a live session's rule-17 trace past the window.

The UI renders this at three zoom levels: a per-turn footer under each answer,
an in-place expansion showing which tools ran and how often, and the session
inspector — one merged timeline with additive filter chips rather than tabs,
since tool calls and audit events interleave and tabs would destroy the ordering
that explains what led to what.

## What a turn shows

One assistant turn carries exactly one metadata affordance: a single line under
the answer (`5 checks · 12.4s · ↑4.2k ↓380 · inspect`) that expands to the
numbered tool trace in execution order with the grounding beneath the calls it
rests on. Execution order is load-bearing — re-sorting by name or duration would
destroy the sequence that explains what led to what.

Before v0.49.0 the same tool calls were described twice, in two vocabularies, on
opposite sides of the answer: a collapsible trace above (v0.46.0) and a metrics
strip below (v0.45.0), plus a third expander for grounding. Each was reasonable
when added; together they made a reader check two places to learn they were the
same five calls.

The live trace during streaming is a separate concern and still renders above the
answer — there the rows are the progress indicator, not a record to consult.

Turns beyond the most recent six collapse to a single line. Standing session
state (deterministic findings) lives in the inspector rather than at the newest
position of a time-ordered thread.

## The session report

`GET /sessions/{id}/report` renders the artifact a user hands to someone else. It
covers the investigation the conversational agent actually carried out — the
questions, excerpted answers with their claimed grounding, the read-only tool
breakdown, what the turns cost, and the session's rule-17 audit trail — alongside
the deterministic summary, linked runs and triage cases.

Before v0.48.0 it drew only from *linked* runs, which for an agent-driven session
is always zero: the agent's own surveys are recorded with `origin='agent'` and
never surfaced as run cards. A real six-turn investigation therefore rendered as
a page of em dashes. The observability built in v0.45–v0.47 existed but never
reached the one document that leaves the app.

Every section is bounded and states when it truncates; the newest turns are kept.
Inputs were sanitized on write and the whole document is redacted again on
render, so the report still contains no raw log lines, no raw inventory rows, no
evidence file content, no credentials and no chain-of-thought.

## What a turn costs

Three things dominate a turn's token bill, and until v0.53.0 two of them were
invisible and one was partly wasted.

**The fixed prefix** — instructions plus tool schemas — is ~5k tokens and is
re-sent on **every step** of a multi-step turn. A turn with eight tool calls
makes nine model requests, so it is paid nine times. It is a stable byte-for-byte
prefix, which is exactly what endpoint prompt caching is for; whether the
endpoint actually caches it is the single biggest factor in what the turn costs.

**The context block** is rebuilt per turn and re-sent per step. It used to be
serialized with `json.dumps(..., indent=2)`: measured on a 40-turn session,
43,547 chars pretty against 37,520 compact — **14% of the context was
indentation**. Tool results had the same issue at smaller scale (a full
`list_objects` page: 75,603 chars against 73,794). Both are compact now; models
parse compact JSON identically, and the indentation only ever helped a human
reading a debug dump. The inspector still pretty-prints at the point a human
actually reads it.

**Tool outputs** accumulate inside a turn — a full 1000-key listing page is
~18k tokens and stays in the conversation for every later step. That echo cannot
simply be trimmed: the S3 layer computes `next_token` over the whole page, so a
smaller echo would drop keys the agent can never page back to.

`turn_metrics` therefore records two more columns (migration 22):
`cached_input_tokens` and `reasoning_tokens`, both straight from the SDK's
`Usage` (`input_tokens_details` / `output_tokens_details`), which has reported
them since usage capture landed and which nothing read. Both are **NULL when the
endpoint did not report them** — "this endpoint does not say" and "nothing was
cached" are different facts, and the repository has a separate `_opt` writer so
the core counts' coalesce-to-zero rule cannot silently answer the first with the
second. A genuine 0 is stored as 0, because a cold cache is the measurement
worth acting on.

### The turn's own governor (v0.54.0)

The three costs above are what a step is worth. What bounds how many steps a
turn may take used to be a **character** budget on cumulative tool output — and
because the SDK re-sends the whole accumulated conversation on every step, a
linear character budget buys a quadratic bill: the same 200k-char budget costs
~406k tokens at 10 steps, 781k at 20, 1.55M at 40. At `_MAX_TURNS = 60` one
question could spend ~3.5M tokens with nothing objecting.

`model_budget.turn_token_budget()` adds the bound denominated in what a turn
costs — `window × 5`, floored at 600k and capped at 4M (640k on a 128k model,
1M on a 200k one) — checked against the SDK's **live** per-run usage before each
tool call. Hitting it is a soft `budget_exhausted` status naming
`spent_tokens`/`budget_tokens`, plus the "continue investigation" proposal, not
an error. On an endpoint that reports no usage the character budget remains the
only bound and the turn says so; absent usage is never read as zero.

Three structural repetitions were removed at the same time:

- **Independent probes go out together.** `parallel_tool_calls` is on, so eight
  independent read-only probes cost 2–4 model requests instead of 9, each of
  which would have re-sent everything before it. Endpoints that answer a
  parallel batch with a sequencing 400 are remembered in
  `_NO_PARALLEL_ENDPOINTS`, keyed `base_url|model` exactly like the
  `stream_options` capability memory: one failure per process, that turn still
  recovers through the finalize pass, and every later turn asks for sequential
  calls. A 400 that is not a sequencing error is never attributed here.
- **An identical `(tool, args)` call inside one turn** returns a `repeat_call`
  pointer to the earlier result instead of the payload — and does not re-issue
  the S3 request. `measure_request_latency` is exempt, because repetition is the
  measurement there and a deduped second sample would be a fabricated number.
- **The prompt is ordered most-stable-first** — skill catalog, providers, then
  the stable half of the context (`session`/`summary`/`agent_memory`), then the
  thread replay, then this turn's attachments and question. Prompt caching
  matches on the prefix and stops at the first differing byte, so the old layout
  (thread replay ahead of the catalog) invalidated everything on every turn.
  Measured across two consecutive turns: the shared prefix goes from 36% to 100%
  below the replay cap, and from 12% to 64% once the replay window slides.

`turn_metrics` gains `budget_tokens` and `repeat_calls_avoided` (migration 23)
so the footer still reports the turn's governor after a reload. Neither is a
provider measurement, and they are reported beside `usage`, never inside it.

## What the access-log engine measures

`analysis/access_logs.py` parses `latency_ms` and `bytes_sent` into the table on
ingest and, until v0.52.0, read neither — so "why is it slow" and "why is it
expensive", the two questions people bring an access log to answer, had no
numbers behind them. It now computes, alongside the existing volume and status
breakdowns:

- **latency percentiles** (p50/p95/p99/max), not an average — the mean of a
  latency distribution hides the tail, and the tail is what gets reported as
  "it's slow";
- **egress** — total bytes served and the keys that account for them, because a
  single hot key served uncached is a different problem from broad traffic;
- **errors by prefix** — which part of the bucket is failing, which a global
  error rate cannot say; ordered by error count so a 100%-failing prefix with
  three requests does not outrank an outage;
- **error rate by hour** — a flat 2% and a 2% that was 40% for one hour are
  different incidents;
- **top talkers**, ranked on the ingest-masked client IP (rule 15).

Every one of these is `null` (absent, never zero) when the log format carries no
such field: many formats have no timing at all, and a "p95 = 0 ms" would be a
false claim about performance. The derived findings follow the same rule and
additionally require a minimum sample before firing.

## What a failure carries

Every live S3 tool returns the same failure shape, built by
`s3/tools.py::_client_error_fields`. Since v0.52.0 that shape carries the
metadata that makes a failure actionable rather than merely reported:

- **`request_id` / `host_id`** — what a provider's support desk asks for first.
  Without them an unexplained 500 or 503 from an S3-compatible gateway is a dead
  end. botocore hands them over on the same exception; they were being dropped,
  while the *offline* triage parser had always extracted `request_id` from
  pasted error text — one product, two standards.
- **`retry_attempts`** — botocore retries throttling transparently, so a request
  that "succeeded" in four seconds looked like an unexplained pause. This is the
  explanation, and it is captured on the success path too.
- **`headers_sanitized`** — the provider's `server` banner and, on a 301,
  `x-amz-bucket-region`: the reliable source for where a bucket really lives
  (AWS repeats it in message prose, most gateways do not). Headers go through
  the standard redaction, which keeps the diagnostic ones and strips
  Authorization / Set-Cookie — asserted by test, not assumed.

It lives in the shared helper on purpose: every tool inherits it, and there is
no per-tool variant to drift. The turn's one-line trace shows
`<code> · req <id>` on failure so the id is visible without expanding anything.

`get_bucket_location` is the matching probe: one read-only call that reports the
bucket's region beside the configured one and says whether they disagree.
Region/endpoint mismatch is the most common S3-compatible misconfiguration and
used to cost a 15-call config summary to diagnose.

## What the agent knows

The session agent keeps its own working memory — facts it established, findings
it recorded, questions it left open (`note_fact` / `record_finding` /
`note_open_question`) — and that memory is replayed into the context of **every**
later turn. It is how the agent stays coherent once the thread rolls past its
replay window.

Until v0.51.0 none of it was visible. `GET /sessions/{id}` did not return it, and
the report rendered only *findings*: the premises behind every conclusion, and
the boundary of the investigation, existed nowhere a person could look. A wrong
fact — "bucket acme-logs is path-style only" — therefore steered the rest of the
session invisibly, and only the agent could correct it.

The inspector now shows the three kinds and lets the user **correct** an item's
text or **resolve** it (closed, not deleted: it leaves the active set and stops
being replayed, but the row survives for the audit trail). Both are the user's
half of tools the agent already had for itself. Text is redacted by the
repository on write, exactly like the agent's own writes — this text goes into a
prompt — and both operations are audited with `by: user`, so a later reader can
tell which premises the agent derived and which a human overrode.

Two neighbours of the same question, "what is this answer actually based on":

- **Attached evidence** is listed alongside it. After the composer's chip
  cleared there was no way to see which files the session held.
- **Context reach**: `context_messages` is how many of `message_total` the agent
  replays for the configured model. When it is lower, the UI says so — the agent
  is working from its memory and the summary, not from a re-read of the whole
  conversation, and a reader who assumes otherwise misjudges the answers.

## Reattaching to a running turn

Client run state (`sessionRuns`) lives in memory so a turn keeps streaming across
session switches. The cost was that reloading the app — or opening the session in
a second window — mid-turn showed an **idle** session while the worker kept
generating and kept spending; the answer surfaced only if the user happened to
reload later.

`GET /sessions/{id}/turn` is the server's answer to "is anything in flight". The
thread asks once per session switch and once per return-to-foreground, then polls
only while a turn is known to be running: a turn cannot start without this
client's knowledge except through those two doors. It shows the fact and the
elapsed time — there is no stream to re-attach to and no partial text to invent —
and reloads the thread when the turn ends. Process-local by design (see
`turn_guard`): after a sidecar restart nothing is running, and saying so is true.

Composer drafts are persisted per session in `localStorage` (`src/drafts.ts`),
including for a chat that does not exist yet — the most common place a draft was
lost, since a fresh chat has no session id until the first message is sent. They
stay client-side deliberately: a draft is UI state, never sent anywhere, and
persisting it server-side would put unsent user text into the audit surface.

## The live trace

While a turn runs, the thread shows one growing list of tool calls whose newest
row carries the spinner. Before v0.53.0 it showed two: a `LiveProgress` summary
line ("5 checks run · list_objects · acme-logs") stacked directly on top of a
`ToolActivityList` rendering those same calls as rows — the duplication v0.49.0
removed from the *finished* state, still present in the live one. The rows are
the progress indicator; a separate counter adds nothing they do not show.

Each row also carries the arguments that decide what the call meant. A row used
to read `list_objects · acme-logs` whether the call was a scan of one prefix or a
recursive walk of the whole bucket — and the arguments had been written to
`tool_calls` all along, they were simply never put on the SSE stream. Only the
distinguishing ones are shown (prefix, aspect, limits, `recursive`, version and
upload ids); `bucket`/`key` are already the row's target and `provider_id` is an
opaque id a reader cannot use. They go through the same redaction as everything
else that reaches the UI.

## Rendering an answer

`frontend/src/components/Markdown.tsx` is a hand-written, dependency-free
renderer. It is hand-written for a security reason and kept that way for a
packaging one: **no HTML is ever injected** — the renderer emits known elements
only, so the XML error bodies and object keys that agent text quotes stay text —
and a CSP that blocks external resources rules out any CDN-delivered library.

It covers headings h1–h6, paragraphs, blockquotes, rules, fenced and inline code,
`**bold**` / `*italic*` / `~~strike~~`, `[links](url)` and bare URLs, pipe tables
with `:--` / `--:` column alignment, and lists — ordered (a real `<ol>`, starting
at the author's number), unordered, task (`- [x]`), and nested, including block
content such as a fenced snippet inside a list item. Only `http(s):` and
`mailto:` are ever made clickable.

Two things sit on top of that renderer:

- **Syntax highlighting** (`frontend/src/lib/highlight.ts`) for the four
  languages this product actually emits — `json` (bucket policies, lifecycle
  rules), `xml` (S3 error bodies, configuration), `bash` (`aws s3api` / `curl`
  reproductions) and `sql` (the analysis SQL in the audit log). It is a
  tokenizer, not a parser: nothing is validated and no claim about correctness
  is implied. Unknown languages and blocks over 20 000 characters render plain.
  The seven palette slots are themed CSS variables measured for AA contrast
  against the code slab in **both** themes.
- **Charts derived from the rendered table** (`frontend/src/components/Chart.tsx`).
  When a table is a measure-by-category shape — a non-numeric first column and a
  column that parses as a number in *every* row — the UI draws ranked bars above
  it, or a column chart when the categories are a time series. The chart is
  derived from the same table the reader sees, never from a second source: no
  extra data reaches the model and no raw row is exposed. The table always stays
  below, because a bar communicates ratio and the precise value still has to be
  readable. Anything ambiguous — a status matrix, a column with one `Provider
  unsupported` cell, negative values, more than 40 rows — draws no chart.

## Frontend design system

All surface, neutral and status colour goes through CSS custom properties
(`frontend/src/index.css`), remapped into Tailwind so `text-gray-300`,
`bg-panel`, `bg-danger-bg` and friends invert per theme without a component
knowing which theme is active. Components must never use a raw palette step of a
status hue (`bg-red-950`), a literal hex, or `bg-black/60`: those bake in one
theme's ground, which is exactly how the light theme rotted before v0.46.0 — 14
components looked correct in dark and rendered dark slabs with pale text on
white. `frontend/src/theme.tokens.test.ts` fails the build on a new escape and
on any semantic token defined in only one theme, and computes WCAG contrast for
the neutral ramp, the status tints and the syntax slots in both themes rather
than leaving it to the eye.

Layers, deepest to most elevated: `canvas` → `sidebar` → `panel` → `elevated` →
`hover`, with `edge` / `edge-strong` borders and a single restrained indigo
accent. Semantic status is a separate axis (`danger` / `warn` / `success`), each
with its own surface, border and foreground so the two themes can be tuned
independently rather than inverted.

Overlays (command palette, settings drawer, session inspector, shortcut sheet)
share `useFocusTrap`: focus moves in, Tab wraps at both ends, and focus is
restored to the opener on close — unless the user has already clicked elsewhere,
where yanking it back would be the ruder option.

## Testing

Three layers, each covering what the one below cannot:

- **Sidecar unit/integration tests** (`sidecar/tests`, pytest) — the bulk of the
  suite: engines, repositories, tool semantics, the security floor (redaction,
  scope, audit), and per-release regression files (`test_v0NNN_fixes.py`) that
  pin each fix to the behaviour it corrected.
- **Frontend unit tests** (`frontend/src/**/*.test.ts*`, Vitest + Testing Library
  in jsdom) — the turn-runner state machine and stores, which are pure logic.
- **E2E smoke** (`frontend/e2e`, Playwright) — the seam the other two cannot
  reach: composer → HTTP → SQLite → SSE → rendered card, driven against a REAL
  sidecar (started on a throwaway data dir) and the production frontend bundle.
  Deliberately credential-free, so it exercises the offline paths a user meets on
  a fresh install and can never go flaky on a model provider.

The E2E specs sit in their own TypeScript project (`tsconfig.e2e.json`) because
they import node builtins the app bundle never touches; `npm run typecheck` runs
both projects, since Playwright itself compiles specs with esbuild and would
strip type errors without reporting them.
