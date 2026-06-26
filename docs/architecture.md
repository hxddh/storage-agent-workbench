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
SQLite / DuckDB / keyring / local files
```

## Tauri

Tauri is responsible for:

- Desktop shell
- Launching the sidecar in later phases
- Packaging
- Local desktop integration

Tauri is not responsible for:

- Agent logic
- S3 logic
- Analysis logic
- Secret processing

## Frontend

The frontend is responsible for:

- Claude/Codex-like three-column UI
- Runs
- Providers
- Datasets
- Reports
- Settings
- Tool Timeline
- Metrics cards
- Findings
- Report preview

## Sidecar

The Python FastAPI sidecar is responsible for:

- Local API
- Health check
- SSE streaming in later phases
- SQLite metadata
- keyring access in later phases
- S3 tools in later phases
- DuckDB analysis in later phases
- Report generation in later phases
- Agent runtime integration in later phases

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

keyring stores secrets:

- Model API keys
- Cloud access keys
- Secret keys
- Session tokens

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

Phase 01 only implements:

```text
GET /health
```

## Future streaming

Use Server-Sent Events for run events:

```text
GET /runs/{run_id}/events
```

Do not introduce WebSocket unless explicitly requested.

## Account discovery (Phase 14)

The `account_discovery` run type builds an account-level asset picture from
read-only APIs:

    test_credentials → list_buckets → (per visible bucket, bounded by
    max_buckets) head_bucket + bucket config snapshot + evidence-source
    discovery → account profile + report.

- **`list_buckets`** (`s3/tools.py`) is the only listing performed — a read-only
  ListBuckets. It never calls ListObjectsV2 and never touches object bodies.
  Capability/permission gaps map to `provider_unsupported` / `access_denied`.
- **`account_tools.get_bucket_config_snapshot`** reuses the Phase 06 read-only
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
  bucket's failure never fails the whole run. Results persist to four SQLite
  tables (account_snapshots, account_snapshot_buckets, bucket_config_snapshots,
  evidence_sources) via `repositories/account_discovery.py`, all JSON
  redaction-passed. `GET /runs/{id}/account-profile` returns the structured
  profile the UI renders as a filterable bucket table.
- Agent mode for `account_discovery` is rejected with a clean 422 — no bucket
  list or config JSON is ever sent to an LLM. Agent account-level analysis is a
  future phase.

## Next-action handoff (Phase 17)

Next-action proposals become an **Agentic hand-over**, never automation:

    Agent proposes → user reviews (preview) → app prepares a prefilled SAFE flow
    → user confirms/starts → existing run/import/report flow runs.

- **Normalized proposals** (`sessions/next_actions.py`): every proposal is
  coerced to a canonical, sanitized shape (`id`, `title`, `reason`,
  `action_type`, `requires_confirmation=true`, `confidence`, `source_run_ids`,
  `required_inputs`, `prefill`, `safety_notes`, `status`). Only an allowlisted
  `action_type` survives (run_account_discovery / run_bucket_config_review /
  run_diagnostic / plan_inventory_import / plan_access_log_import /
  run_inventory_analysis / run_access_log_analysis / generate_session_report /
  ask_user_for_context); anything else is dropped.
- **Preview** (`POST /sessions/{id}/actions/preview`) and **prepare**
  (`POST /sessions/{id}/actions/prepare`) ONLY validate + prefill against session
  state. They never create a run, download evidence, confirm an import, call S3,
  or call an LLM. Prepare returns which existing flow to `open` (new_run /
  evidence_import / session_report / message_composer) plus a sanitized prefill;
  missing parameters yield `needs_input` (and candidate evidence sources when a
  choice is required) rather than a guess.
- **Reuse, not a parallel workflow:** the frontend opens the existing
  `NewRunForm` (with `session_id` + prefilled run_type/provider/bucket) or
  `EvidenceImportDialog` (prefilled account run + bucket + source_type; the
  imported analysis run is then attached to the session). Evidence import still
  goes plan → confirm → run; a new run still starts only when the user clicks.
  The Agent never executes.
- **Assistant proposals:** the session assistant may additionally return a
  fenced-JSON `proposed_actions` block; the backend validates/coerces each
  through the same allowlist (dropping invalid ones, forcing
  `requires_confirmation`). It remains interpretation-only with no tools.
- **Audit:** `next_action_previewed` / `next_action_prepared` /
  `next_action_opened` — lightweight events, not a task lifecycle (no
  assignee/status-board/ticket state).

## Error triage assistant (Phase 18)

A session-centered capability to triage S3 / object-storage / S3-compatible
errors — NOT a static FAQ or error-code dictionary page.

    paste error -> redact -> deterministic parse -> playbook match ->
    candidate causes + evidence + next checks -> (optional) Agent interpretation
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
  causes + safe next checks + next-action proposals (normalized through the
  Phase 17 allowlist). It performs NO S3 call, run, download, or mutation.
- **`error_triage/triage_agent.py`** is interpretation-only (seam `TRIAGE_LOOP`,
  `tools=[]`): the model sees ONLY the sanitized triage context (parsed signals +
  candidate-cause titles/why + next checks), never the raw blob, never secrets.
  Output is redacted + chain-of-thought-stripped; a missing model key fails
  cleanly and the deterministic triage is unaffected.
- **API**: `POST /error-triage`, `GET /error-triage/{id}`,
  `GET /sessions/{id}/error-triage`. A case binds to its session and the session
  summary is refreshed; cases also appear in the session report's Error triage
  section. Next actions are Phase 17 proposals — the user reviews/prepares them.
- Persistence (`error_triage_cases`, `error_triage_findings`) stores only the
  redacted input + sanitized parsed signals/findings — never raw sensitive logs,
  secrets, or chain-of-thought. This is not a ticketing system.

## Session-centered agentic workbench (Phase 16)

The product is a **session-centered agentic workbench**, not a cloud-management
dashboard or project tracker. The model is:

    Goal → Evidence → Runs → Findings → Agent interpretation → Next actions → Report

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
- **Interpretation-only assistant** (`agent_runtime/session_agent.py`,
  `SESSION_LOOP` seam): on a user message, the deterministic summary is built
  first; the model sees ONLY a sanitized bounded context (goal + summary +
  recent messages) and answers. It has no tools — it cannot run, download,
  mutate, query SQL, or call S3 — it only explains and recommends which existing
  proposal to take. Output is redacted + chain-of-thought-stripped. A missing
  model key fails cleanly (422) and never affects the deterministic summary.
- **Next actions** are proposals only (`requires_confirmation: true`); the user
  acts. They are not a task list / kanban / ticket queue.
- **Reports** (`sessions/session_report.py`): goal, executive summary, evidence
  used, run timeline, key findings, confidence/limitations, recommended next
  actions, appendix of linked runs — secret-free, no raw content.
- **Not** a CMDB, monitoring wall, ticketing/kanban/PM system, object browser,
  or multi-user/permission surface. No such tables or endpoints exist.

## Managed evidence import (Phase 15)

Connects account_discovery (Phase 14) to the Phase 05 DuckDB analysis path,
under a bounded, confirmation-gated flow:

    discover inventory/logging source → plan → (explicit) confirm → run
    (download evidence files only) → existing inventory_analysis /
    access_log_analysis.

- **Endpoints** (`routers/evidence_imports.py`): `POST /evidence-imports/plan`,
  `GET /evidence-imports/{id}`, `GET /evidence-imports/{id}/files`,
  `POST /evidence-imports/{id}/confirm`, `POST /evidence-imports/{id}/run`.
- **Source validation:** a plan request names an account_discovery run + bucket
  + source type; the server resolves the *discovered* evidence destination from
  the persisted Phase 14 evidence source (inventory destination bucket/prefix or
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

## Agent planner modes

Runs carry a `planner_mode` (`deterministic` by default, or `agent`). Two
distinct agent paths exist:

- **Tool-calling planner** (Phase 07) — for `diagnostic` and
  `bucket_config_review`. A controlled LLM loop selects from the read-only
  whitelist tools through the shared tool runner; outputs are sanitized/bounded
  before reaching the model. Implemented in `agent_runtime/agent_service.py`
  (seam: `AGENT_LOOP`).
- **Interpretation-only narrator** (Phase 13) — for `access_log_analysis` and
  `inventory_analysis`. The deterministic DuckDB analysis runs first and
  produces metrics + findings; the executor then hands the model **only** a
  bounded, sanitized aggregate context (run/dataset metadata + metrics +
  findings) and asks for a structured narrative. The model has **no tools**, so
  it cannot reach raw logs/rows, SQL, object listings, or any S3 API.
  Implemented in `agent_runtime/analysis_agent.py` (seam: `ANALYSIS_LOOP`); the
  analysis executors (`runs/access_log_run.py`, `runs/inventory_run.py`) branch
  on `planner_mode`. `run_service` routes these run types to their executor (not
  to the tool-calling planner) regardless of mode.

Both seams are mockable so tests run without the OpenAI Agents SDK or an API
key. A missing model provider key fails the agent run cleanly and never affects
deterministic runs. The generated report keeps deterministic metrics and the
agent interpretation in separate, clearly-labelled sections.

## Packaging & desktop integration (Phase 08)

- The Python sidecar is bundled with PyInstaller (`sidecar/packaging/`) into a
  one-dir executable, `storage-agent-sidecar`.
- The Tauri v2 shell launches the bundled sidecar as a child process on a free
  localhost port, passes `STORAGE_AGENT_DATA_DIR` (the OS app-data dir), exposes
  the URL via the `get_sidecar_url` command, and terminates it on app exit.
- Dev mode runs the sidecar separately; the frontend resolves the URL from
  `VITE_SIDECAR_URL` (dev) or the Tauri command (prod), with a localhost
  fallback. The only spawned process is the internal sidecar — there is no
  user-facing shell/subprocess tool.
- See `docs/packaging.md`. Rust toolchain is required for the desktop build.
