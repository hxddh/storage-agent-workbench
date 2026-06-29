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
  proposed next actions render as inline cards.
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
- The conversational session agent and analysis narrators (OpenAI Agents SDK)
  and report generation.

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

Run events stream over Server-Sent Events, with a blocking fallback when SSE is
unavailable. WebSocket is intentionally not used.

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
  bucket's failure never fails the whole run. Results persist to four SQLite
  tables (account_snapshots, account_snapshot_buckets, bucket_config_snapshots,
  evidence_sources) via `repositories/account_discovery.py`, all JSON
  redaction-passed. `GET /runs/{id}/account-profile` returns the structured
  profile the UI renders as a filterable bucket table.
- Agent mode for `account_discovery` is rejected with a clean 422 — no bucket
  list or config JSON is ever sent to an LLM. Agent account-level analysis is a
  future phase.

## Next-action handoff

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
  goes plan → confirm → run. Expensive/data-moving actions (analysis on an
  uploaded dataset, evidence import) always remain confirmed proposals — the
  agent never auto-runs them.
- **Inline execution of safe read-only runs:** under the `autonomous_readonly`
  autonomy policy (the default), the session agent may EXECUTE the SAFE_READONLY
  runs itself (`run_diagnostic` / `run_bucket_config_review` /
  `run_account_discovery` — `agent_runtime/session_action_tools.py`) instead of
  only proposing them, and fold the findings into its answer. Under `assisted`
  it proposes them for the user to confirm. Either way these create real,
  audited, read-only runs; nothing mutating or data-moving is ever auto-run, and
  inline runs are bounded by a wall-clock timeout so a heavy run can't stall the
  turn. See "Agent autonomy" below.
- **Assistant proposals:** the session agent may additionally return a
  fenced-JSON `proposed_actions` block; the backend validates/coerces each
  through the same allowlist (dropping invalid ones, forcing
  `requires_confirmation`).
- **Audit:** `next_action_previewed` / `next_action_prepared` /
  `next_action_opened` — lightweight events, not a task lifecycle (no
  assignee/status-board/ticket state).

## StorageOps skill context injection

The existing Agents gain **professional-method context** from the bundled
StorageOps skill pack — skills-only, guidance-only. It is NOT a skills platform:
no StorageOps tools, helper scripts, CLI, Pi runtime, subprocess, MCP,
multi-agent runtime, skill API, skill UI, skill DB tables, or RAG.

- **Vendored** under `sidecar/app/bundled_skillpacks/storageops/`: only
  `skill-registry.yaml` + `skills/*/SKILL.md` (16 skills). No `references/`,
  `templates/`, `scripts/`, `storageops_cli/`, or `extensions/` are copied.
- **`skills/loader.py`** parses minimal registry metadata (name / path /
  description / maturity / mode / trigger_keywords / domains / auto_route) and
  loads SKILL.md bodies. `recommended_tools` is deliberately NOT exposed — never
  registered, shown, or executed.
- **`skills/selection.py`** is a lightweight lexical selector: it matches the
  input context (session goal + summary + question + plain-text error signals)
  against registry metadata and returns 1–3 candidates as
  `{name, match_reason, selection_basis}` only — no diagnosis / root cause /
  remediation / confidence / score, and no hard-coded error-code → skill mapping
  (fallback is the registry's `auto_route` skill, a metadata property).
- **`skills/context.py`** wraps each selected SKILL.md in a tools-disabled safety
  preamble ("StorageOps tools / scripts / CLI / Pi runtime … are disabled in
  this Workbench phase; do not claim to run tools; use mentions as conceptual
  guidance only"), bounded by a max-char budget and a 1–3 skill cap.
- **Injection**: `agent_runtime/session_agent.py` and
  `error_triage/triage_agent.py` add the selected SKILL.md context to the prompt
  (not to the sanitized evidence context) and emit a minimal contract via
  `skills/contract.py`: `{answer, skills_used, evidence_used, evidence_gaps,
  next_action_proposals}` — answer redacted + CoT-stripped, skills_used limited
  to injected skills, proposals coerced through the allowlist. The raw
  error blob / secrets / chain-of-thought never reach the model. Deterministic
  triage (or a missing model key) does not fabricate a skill-grounded diagnosis.
- No migration / DB table / public skill API was added; skill-grounded fields
  ride existing session-message responses and the triage case JSON, and the
  session report lightly absorbs `skills_used` / `evidence_gaps` when present.

## Error triage assistant

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
  the allowlist). It performs NO S3 call, run, download, or mutation.
- **`error_triage/triage_agent.py`** is interpretation-only (seam `TRIAGE_LOOP`,
  `tools=[]`): the model sees ONLY the sanitized triage context (parsed signals +
  candidate-cause titles/why + next checks), never the raw blob, never secrets.
  Output is redacted + chain-of-thought-stripped; a missing model key fails
  cleanly and the deterministic triage is unaffected.
- **API**: `POST /error-triage`, `GET /error-triage/{id}`,
  `GET /sessions/{id}/error-triage`. A case binds to its session and the session
  summary is refreshed; cases also appear in the session report's Error triage
  section. Next actions are the proposals — the user reviews/prepares them.
- Persistence (`error_triage_cases`, `error_triage_findings`) stores only the
  redacted input + sanitized parsed signals/findings — never raw sensitive logs,
  secrets, or chain-of-thought. This is not a ticketing system.

## Session-centered agentic workbench

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
- **Conversational session agent** (`agent_runtime/session_agent.py`,
  `SESSION_LOOP` seam): the primary surface, a genuine tool-calling loop. The
  deterministic summary is built first for grounding; the agent then investigates
  LIVE with **read-only** tools (`agent_runtime/session_tools.py`: list_buckets,
  head_bucket, bounded/paginated list_objects, head_object, test_credentials,
  test_addressing_style, inspect_endpoint_tls, test_range_get, the
  `review_bucket_*`/`get_bucket_config_summary` config readers, and `read_skill`
  for progressive-disclosure StorageOps skills), chooses provider/bucket itself,
  and grounds its answer in tool output. It has **working memory**
  (`session_agent_memory` table via `session_memory_tools.py`): `note_fact` /
  `record_finding` / `note_open_question` persist sanitized, audited items that
  are fed back into later turns. It self-verifies high-severity conclusions with
  a tool before asserting them. Under the autonomy policy it may also EXECUTE
  read-only runs (see below). What it still cannot do: download object bodies,
  mutate anything, run free SQL/shell, reach any destructive S3 op, or see any
  secret — credentials are resolved server-side inside the S3 layer and never
  enter the model context. Output is redacted + chain-of-thought-stripped +
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

How much the conversational agent does on its own is a per-install setting
(`agent_runtime/autonomy.py`, persisted in `app_settings`; `GET`/`PUT
/settings/autonomy`). The security tiers are enforced *below* this setting and
never change with it.

- **`assisted`** — the agent proposes read-only runs for the user to confirm.
- **`autonomous_readonly`** (the **default**) — the agent executes SAFE_READONLY
  runs itself (diagnostic, bucket_config_review, account_discovery) and folds the
  findings into its answer.

Risk tiers, independent of policy: `SAFE_READONLY` (read-only runs + the
sanitized session report) may auto-run under `autonomous_readonly`;
`EXPENSIVE`/data-moving work (dataset analysis, evidence import/download, large
scans) and any `MUTATING` op are **never** auto-run under either policy — they
stay confirmed proposals. There is no write/destructive tool in the product at
all. (A retired `advisory` value normalizes to `assisted` on read.)

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
  the persisted the evidence source (inventory destination bucket/prefix or
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

- **Tool-calling planner** — for `diagnostic` and
  `bucket_config_review`. A controlled LLM loop selects from the read-only
  whitelist tools through the shared tool runner; outputs are sanitized/bounded
  before reaching the model. Implemented in `agent_runtime/agent_service.py`
  (seam: `AGENT_LOOP`).
- **Analysis narrator with bounded drill-down** — for `access_log_analysis` and
  `inventory_analysis`. The deterministic DuckDB analysis runs first and produces
  metrics + findings; the executor then hands the model a bounded, sanitized
  aggregate context (run/dataset metadata + metrics + findings) and asks for a
  structured narrative. The model gets a small set of **bounded, read-only
  aggregate tools** over the already-local DuckDB dataset (`analysis/drilldown.py`:
  `aggregate_by(dimension, metric, limit)` and `count_where(field, op, value)`,
  over whitelisted dimensions/fields with parameterized values) so it can drill
  into the metrics — but **no raw rows, no free SQL, no object listings, no S3
  API, no object bodies**. Implemented in `agent_runtime/analysis_agent.py`
  (seam: `ANALYSIS_LOOP`); the executors (`runs/access_log_run.py`,
  `runs/inventory_run.py`) branch on `planner_mode` and pass the dataset's
  `duckdb_path`. `run_service` routes these run types to their executor (not to
  the tool-calling planner) regardless of mode.

Both seams are mockable so tests run without the OpenAI Agents SDK or an API
key. A missing model provider key fails the agent run cleanly and never affects
deterministic runs. The generated report keeps deterministic metrics and the
agent interpretation in separate, clearly-labelled sections.

## Packaging & desktop integration

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
