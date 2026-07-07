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
  bucket's failure never fails the whole run. Results persist to four SQLite
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
  localhost port, passes `STORAGE_AGENT_DATA_DIR` (the OS app-data dir), exposes
  the URL via the `get_sidecar_url` command, and terminates it on app exit.
- Dev mode runs the sidecar separately; the frontend resolves the URL from
  `VITE_SIDECAR_URL` (dev) or the Tauri command (prod), with a localhost
  fallback. The only spawned process is the internal sidecar — there is no
  user-facing shell/subprocess tool.
- See `docs/packaging.md`. Rust toolchain is required for the desktop build.
