# Data model

> **Storage Agent v0.98.0 persistence reference.** Schema unchanged from v0.96.0 (migration head **027**). `GET /agent-tasks/{id}/provenance` is a read-only projection, not a new table. v0.98 is content presentation.
>
> Product vocabulary is Agent Task / Direction / Execution / Decision / Work Result / Artifact. SQLite/API table names predate that product model and remain compatibility contracts. Do not derive frontend information architecture from table names.

## Storage layers

Storage Agent uses three local storage layers:

1. **SQLite** — application metadata, durable task/execution state, audit/provenance, references. No analytical raw tables and no plaintext secrets.
2. **DuckDB** — local analytical data for uploaded/imported inventory and access logs plus derived metrics.
3. **Local files** — raw uploaded/imported evidence, DuckDB files, and generated report artifacts under the application data directory.

Secrets are stored separately in the encrypted local vault. SQLite stores only opaque `keyring://...` references.

## Migration contract

The schema is created by append-only migrations in `sidecar/app/migrations.py`.

**Current migration head: 027.**

Rules:

- never edit a migration that has shipped;
- append a new migration for schema changes;
- migration recovery logic is part of the data-safety contract;
- product renaming does not require risky storage renaming when an adapter boundary is sufficient.

### Migration index

| Version | Name | Purpose |
| ---: | --- | --- |
| 001 | `initial_schema` | provider/run/message/tool/audit/dataset/report metadata |
| 002 | `tool_calls_nullable_run` | allow ad-hoc tool calls without a run |
| 003 | `runs_add_prefix` | optional run prefix scope |
| 004 | `datasets_metadata` | richer deterministic-analysis dataset metadata |
| 005 | `runs_add_planner_mode` | historical column retained for compatibility |
| 006 | `account_discovery` | account/bucket/config/evidence-source snapshots + run options |
| 007 | `managed_evidence_import` | bounded planned/confirmed evidence import records |
| 008 | `session_workspace_context` | durable session/task context, linked runs/evidence/findings/messages/summary |
| 009 | `error_triage` | deterministic storage-error triage cases/findings |
| 010 | `session_message_tool_activity` | persisted sanitized activity summary on assistant messages |
| 011 | `sessions_pinned` | pinned task/session navigation state |
| 012 | `app_settings` | non-secret local settings |
| 013 | `session_agent_memory` | durable Agent-authored facts/findings/open questions |
| 014 | `session_datasets` | task/session-scoped uploaded datasets |
| 015 | `runs_add_origin` | distinguish user vs Agent-internal deterministic runs |
| 016 | `session_message_grounding` | persisted grounding + proposed actions |
| 017 | `model_provider_context_window` | optional operator-declared context window |
| 018 | `retention_indexes` | created-at indexes for bounded startup retention work |
| 019 | `model_provider_max_output` | optional operator-declared model output cap |
| 020 | `session_scoped_observability` | attach audit/tool-call rows to durable task/session identity |
| 021 | `turn_metrics` | per-turn duration, requests, model/tool/token usage when reported |
| 022 | `turn_metrics_token_details` | cached-input and reasoning token detail |
| 023 | `turn_metrics_budget` | runtime token budget + repeated-call avoidance metrics |
| 024 | `session_datasets_truncation` | persist task-upload truncation/ingest cap and force legacy re-import |
| 025 | `datasets_truncation` | persist run-dataset truncation/ingest cap |
| 026 | `durable_task_runtime` | durable Agent Task/Execution objects, structured execution events, first-class Decision/Work Result/Artifact rows, typed versioned Storage Task Context |
| 027 | `optimization_copilot` | local price table, versioned remediation plans, task baselines, per-task revisit schedules, artifact status/payload |

## Product-to-persistence mapping

| Product concept | Durable runtime representation (v0.94) | SQLite/API compatibility representation |
| --- | --- | --- |
| Agent Task | `agent_tasks` (id equals the compatibility session id) | `sessions`; product surface `/agent-tasks` |
| Direction | `task_executions.direction` (+ durable steer events) | `session_messages` (user rows) |
| Execution | `task_executions` + `execution_events` (append-only structured progress) | `runs`, `session_runs`, `tool_calls`, `turn_metrics` |
| Work Result | `work_results` (runtime metadata; content via `message_id`) | `session_messages` (assistant rows) |
| Decision | `task_decisions` (pending / approved / declined / superseded) | `session_messages.proposed_actions`, `approval_events`, evidence-import state |
| Artifact | `task_artifacts` (unified index over reports/imports/analyses/remediation plans/baselines/drift) | `reports`, evidence-import tables, report files, `remediation_plans` |
| Remediation Plan | `remediation_plans` (`proposed` / `verified` / `partially_verified` / `stale`) | indexed via `task_artifacts` |
| Baseline | `task_baselines` (bounded snapshot JSON, not raw rows) | — |
| Revisit schedule | `task_revisit_schedules` | executed as `task_executions.kind=revisit` |
| Price table | `storage_price_table` (ordinary config; example rates until confirmed) | `/settings/price-table` |
| Storage Task Context | `task_context_versions` (typed, versioned machine state) | — |
| Task summary | `session_summaries` |
| Task findings | `session_findings` |
| Task memory | `session_agent_memory` |
| Evidence refs/sources | `session_evidence_refs`, `evidence_sources`, evidence-import tables |
| Artifact/report | `reports`, report paths/endpoints/files |
| Local attached evidence | `session_datasets` |

The compatibility word `session` is not a current product-navigation concept.

## SQLite tables

Current tables include:

- `schema_migrations`
- `model_providers`
- `cloud_providers`
- `runs`
- `messages`
- `tool_calls`
- `approval_events`
- `audit_logs`
- `datasets`
- `reports`
- `account_snapshots`
- `account_snapshot_buckets`
- `bucket_config_snapshots`
- `evidence_sources`
- `evidence_imports`
- `evidence_import_files`
- `sessions`
- `session_runs`
- `session_evidence_refs`
- `session_findings`
- `session_messages`
- `session_summaries`
- `session_agent_memory`
- `session_datasets`
- `turn_metrics`
- `error_triage_cases`
- `error_triage_findings`
- `app_settings`
- `agent_tasks`
- `task_executions`
- `execution_events`
- `work_results`
- `task_decisions`
- `task_artifacts`
- `task_context_versions`
- `storage_price_table`
- `remediation_plans`
- `task_baselines`
- `task_revisit_schedules`

## Provider metadata

### `model_providers`

Important fields:

- `id`, `name`, `provider_type`, `base_url`, `model`;
- `api_key_ref` — opaque encrypted-vault reference, never secret plaintext;
- `context_window` — optional operator declaration (migration 017);
- `max_output_tokens` — optional operator declaration (migration 019);
- timestamps.

### `cloud_providers`

Important fields:

- provider identity/type/endpoint/region;
- addressing/signature configuration;
- `access_key_ref`, `secret_key_ref`, `session_token_ref` — opaque vault references;
- `mode` (read-only is the shipped capability model; `test-write` remains reserved schema vocabulary with no shipped write tool);
- allowed bucket/prefix JSON scopes;
- timestamps.

## Deterministic Execution records

### `runs`

A `run` is compatibility storage for deterministic/auditable execution, not a top-level product page.

Important fields:

- `id`, `run_type`, `title`, `status`;
- `provider_id`, `bucket`, `prefix`;
- `user_prompt`, `final_summary`, `report_path`;
- historical `planner_mode` (retained, no longer a product/runtime planner switch);
- `options_json` for bounded non-secret execution options;
- `session_id` linking execution to its owning Agent Task when applicable;
- `origin` (`user` or `agent`);
- timestamps.

Current deterministic `run_type` values include:

- `diagnostic`
- `access_log_analysis`
- `inventory_analysis`
- `bucket_config_review`
- `account_discovery`

### `tool_calls`

Fields include:

- `id`;
- nullable `run_id`;
- nullable `session_id` for task-scoped observability;
- `tool_name`;
- sanitized input/output JSON;
- status/duration/timestamp.

A Tool call may belong directly to an Agent Task without belonging to a deterministic run.

### `audit_logs`

Fields include:

- `id`, nullable `run_id`, nullable `session_id`;
- `event_type`;
- sanitized payload JSON;
- timestamp.

### `approval_events`

Stores explicit confirmation decisions associated with gated operations/executions. Detail is sanitized.

## Agent Task compatibility records

### `sessions`

Compatibility storage for the durable Agent Task:

- `id`;
- `title`, `goal`;
- `provider_id`, `primary_bucket`;
- `status`;
- `pinned`;
- timestamps.

The current UI projects this record into Agent Task semantics rather than exposing a “session” application model.

### `session_messages`

Durable Direction and Work Result records:

- `id`, `session_id`, `role`, `content`;
- referenced run/evidence ids;
- sanitized `tool_activity`;
- sanitized `grounding`;
- sanitized `proposed_actions`;
- timestamp.

The latest assistant-side `proposed_actions` is also used by the `/agent-tasks` projection to recover current durable Needs decision state after reload/restart.

### `session_runs`

Links deterministic/auditable executions to the owning Task/session.

### `session_evidence_refs`

Links a Task to persisted Evidence references and sanitized summaries.

### `session_findings`

Stores durable evidence-backed findings including category/severity/confidence/kind/title/evidence/interpretation/status.

### `session_summaries`

One current deterministic summary per Task/session:

- summary Markdown;
- known facts;
- open questions;
- next actions;
- findings;
- limitations;
- update timestamp.

### `session_agent_memory`

Agent-authored working memory replayed into later work:

- `kind` (fact/finding/open question style categories);
- redaction-passed text;
- optional severity/confidence/source execution;
- active/resolved status;
- timestamp.

### `session_datasets`

Files attached to an Agent Task for local analysis:

- dataset identity/type/source filename;
- relative stored/DuckDB paths;
- table name/row count/detected format;
- status;
- `truncated` and `ingest_cap` (migration 024);
- timestamp.

Migration 024 intentionally resets legacy imported rows to `uploaded` so old datasets are re-imported once and acquire truthful truncation metadata.

## Turn metrics

`turn_metrics` stores what can be measured/reported for one Agent turn:

- ids for row/task/turn/message;
- model;
- request count;
- `input_tokens`, `output_tokens`, `total_tokens` when the provider reports them;
- `cached_input_tokens`, `reasoning_tokens` when reported;
- `duration_ms` and tool-call count;
- `budget_tokens` — Storage Agent's per-turn governor ceiling;
- `repeat_calls_avoided` — identical calls answered from the current work context instead of re-running;
- timestamp.

**NULL means not reported/unknown, not zero.** The UI must not convert missing provider usage into a measured `0`.

## Durable Agent Task runtime (v0.94)

The task runtime's own durable records. The Agent Task is a durable domain
object (`agent_tasks.id` equals the compatibility session id, 1:1) and an
Execution is a durable object with a real lifecycle:

- `agent_tasks` — task lifecycle (`ready` / `working` / `needs_decision` /
  `needs_attention` / `archived`), active execution pointer, context version.
- `task_executions` — one unit of delegated work. Lifecycle: `queued` →
  `running` → `completed` | `waiting` (a confirmation-gated Decision is
  pending) | `failed` | `cancelled` | `interrupted` (stamped by restart
  recovery; resumable). `turn_id` carries client idempotency durably
  (a unique index arbitrates duplicate submits).
- `execution_events` — append-only structured progress keyed by sequence
  number: status transitions, tool started/completed, steer received/applied,
  decision opened/resolved, work result recorded, context updated. Sanitized,
  bounded payloads; answer deltas are never persisted here. Periodic (and
  startup) retention may prune **terminal** Executions only (completed/failed/cancelled/interrupted),
  dual-capped by age and per-execution count, using a SQL set delete rather than
  loading events into Python; truncation rewrites the oldest
  dropped row as an explicit `execution.events_truncated` marker and never
  touches queued/running/waiting logs. `0` on either cap disables that cap.
- `work_results` — the durable output of an execution: stopped/cut-short flags,
  grounding and proposals; the text stays on the linked `session_messages` row.
- `task_decisions` — first-class Decision rows for confirmation-gated
  proposals; a newer Work Result supersedes older pending decisions. At most
  one pending Decision exists per `(task, action_type)`; a later proposal of
  the same type supersedes the earlier pending row.
- `task_artifacts` — the unified Artifact index (`report`, `evidence_import`,
  `analysis`, `remediation_plan`, `baseline`, `drift_report`) pointing at the
  durable referent via `ref_kind`/`ref_id`. Optional `status` and sanitized
  `payload` hold plan verification state and bounded Drift summaries.
- `task_context_versions` — the typed Storage Task Context (schema-versioned
  JSON snapshot of machine state: provider scope, buckets in focus, evidence on
  hand, memory counts, open decisions), appended only when changed. Recovery
  and the Agent prompt's stable half read this; they never replay messages to
  rebuild machine state.
- `storage_price_table` — local ordinary configuration (per-class GB-month and
  request/retrieval rates). Ships as an example schedule labelled as such;
  `confirmed` starts false. Not a secret store; credentials never belong here.
- `remediation_plans` — versioned typed repair documents (`proposed` /
  `verified` / `partially_verified` / `stale`) with sanitized plan JSON and the
  simulator payload they were drafted from.
- `task_baselines` — versioned bounded snapshots (inventory overview, config
  facts, findings, context version). Not raw inventory/log rows.
- `task_revisit_schedules` — optional per-task interval, next due time, and
  catch-up note. Revisit Executions use `kind=revisit` on `task_executions`.

## Account/config discovery records

### `account_snapshots`

One bounded discovery result with provider/run identity, bucket/visibility/processed counts, truncation/list status, sanitized summary, and timestamp.

### `account_snapshot_buckets`

Per-bucket discovery rows containing bucket/region/access status.

### `bucket_config_snapshots`

Per-bucket sanitized configuration summary snapshots.

### `evidence_sources`

Discovered evidence-source metadata/status. Discovery does not itself import the evidence body.

## Managed Evidence Import

### `evidence_imports`

Stores bounded plan/confirmation/execution state:

- provider/account snapshot/source identity;
- evidence destination bucket/prefix/ref;
- format/schema/plan source;
- file/byte/time bounds;
- planned/selected counts/bytes;
- state/status and linked analysis run;
- warnings;
- created/confirmed timestamps.

### `evidence_import_files`

Stores the bounded file set associated with an import plan and per-file selection/status metadata.

A plan is not execution. Confirmation state is part of the durable safety boundary.

## Error triage

### `error_triage_cases`

Stores redacted pasted input plus sanitized parse/summary state associated with a Task when applicable. The historical `planner_mode` column is retained but no longer represents a live planning architecture.

### `error_triage_findings`

Stores deterministic triage findings, evidence, interpretation, next checks, and source references.

## Datasets and reports

### `datasets`

Deterministic-run-scoped dataset metadata:

- `run_id`, dataset type/name/source filename;
- relative stored/DuckDB paths/table;
- row count/status;
- `truncated` and `ingest_cap` (migration 025);
- timestamp.

### `reports`

Stores run-associated report metadata/path. Task report endpoints may aggregate the durable Task record beyond a single run.

## App settings

`app_settings` is a small non-secret key/value store. It must never become a secret store.

## Redaction/persistence rule

Any column described as sanitized/redacted/content/JSON may contain only data that has passed the repository's redaction and bounded-context rules as appropriate.

Do not persist:

- plaintext access/secret/session/model credentials;
- Authorization/cookie/bearer material;
- signatures/presigned credentials;
- raw chain-of-thought;
- unbounded raw analytical rows in task messages/audit/tool context;
- absolute user paths when a relative app-data path is sufficient.

## Secret references

SQLite may store only opaque references such as:

```text
keyring://scope/name
```

The actual secret is in the encrypted local vault managed by `security/keyring_store`.

## DuckDB

DuckDB is used for local analytical data such as:

- access-log rows;
- inventory rows;
- sampled/derived object metadata as implemented by analyzers;
- derived aggregate tables/metrics.

The model does not receive unrestricted DuckDB access or arbitrary SQL.

## Local file layout

Exact paths are rooted under the configured application data directory. Representative compatibility layout:

```text
data/runs/{run_id}/raw/
data/runs/{run_id}/analysis.duckdb
data/runs/{run_id}/report.md

data/sessions/{session_id}/raw/{filename}
data/sessions/{session_id}/{dataset_id}.duckdb
```

`session` in the filesystem path is compatibility naming. It stores Agent Task attachments.

Paths persisted in SQLite should remain relative to the application data directory so usernames/home-directory details do not leak into logs, tool records, or reports.
