# Data model

## SQLite

SQLite stores app metadata only — no analytical (DuckDB) data and no plaintext
secrets (only `keyring://` references). The schema is created by the append-only
migrations in `sidecar/app/migrations.py`; the tables below reflect every
migration through 016.

Tables:

- `schema_migrations` (migration bookkeeping: version, name, applied_at)
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
- `error_triage_cases`
- `error_triage_findings`
- `app_settings`

## model_providers

Fields:

- id
- name
- provider_type
- base_url
- model
- api_key_ref
- created_at
- updated_at

## cloud_providers

Fields:

- id
- name
- provider_type
- endpoint_url
- region
- addressing_style
- signature_version
- access_key_ref
- secret_key_ref
- session_token_ref
- mode
- allowed_buckets_json
- allowed_prefixes_json
- created_at
- updated_at

## runs

Fields:

- id
- run_type
- title
- status
- provider_id
- bucket
- prefix (migration 003 — optional prefix scope)
- user_prompt
- final_summary
- report_path
- planner_mode (migration 005 — retained, defaults `'deterministic'`; no longer read or written)
- options_json (migration 006 — bounded discovery options; never secrets)
- session_id (migration 008 — owning session, if any)
- origin (migration 015 — `'user'` or `'agent'`; `'agent'` runs are the conversational agent's own read-only survey/review compute and are filtered out of the thread)
- created_at
- updated_at

## messages

Fields: id, run_id, role, content, created_at.

## tool_calls

Fields:

- id
- run_id (nullable since migration 002 — ad-hoc tool calls need no run)
- tool_name
- input_json_sanitized
- output_json_sanitized
- status
- duration_ms
- created_at

## approval_events

Fields: id, run_id, action, decision, detail_json_sanitized, created_at.

## audit_logs

Fields:

- id
- run_id
- event_type
- payload_json_sanitized
- created_at

## datasets

Rebuilt in migration 004 to carry analysis-dataset metadata. Fields:

- id
- run_id
- dataset_type
- name
- source_filename
- stored_path
- duckdb_path
- table_name
- row_count
- status (defaults `'uploaded'`)
- created_at

## reports

Fields: id, run_id, report_path, format (defaults `'markdown'`), created_at.

## Account discovery (migration 006)

- `account_snapshots` — id, run_id, provider_id, bucket_count, visible_count,
  processed_count, truncated, list_status, summary_json_sanitized, created_at.
- `account_snapshot_buckets` — id, snapshot_id, run_id, provider_id,
  bucket_name, region, access_status, created_at.
- `bucket_config_snapshots` — id, snapshot_id, run_id, provider_id, bucket_name,
  config_summary_json_sanitized, created_at.
- `evidence_sources` — id, snapshot_id, run_id, provider_id, bucket_name,
  source_type, status, detail_json_sanitized, created_at.

## Managed evidence import (migration 007)

- `evidence_imports` — id, provider_id, account_run_id, snapshot_id,
  source_type, source_bucket, source_prefix, evidence_ref, format, fmt_schema,
  plan_source, max_files, max_bytes, time_range_start, time_range_end,
  planned_file_count, planned_total_bytes, selected_file_count,
  selected_total_bytes, status (defaults `'planned'`), analysis_run_id,
  warnings_json, created_at, confirmed_at.
- `evidence_import_files` — id, import_id, object_key, size_bytes, kind,
  selected, status (defaults `'planned'`), created_at.

## Sessions (migration 008, extended by 010/011/013/014/016)

- `sessions` — id, title, goal, provider_id, primary_bucket, status,
  pinned (migration 011), created_at, updated_at.
- `session_runs` — id, session_id, run_id, role, created_at.
- `session_evidence_refs` — id, session_id, source_type, source_id,
  source_run_id, summary_json, created_at.
- `session_findings` — id, session_id, source_run_id, category, severity,
  confidence, kind, title, evidence_json, interpretation, status, created_at.
- `session_messages` — id, session_id, role, content, referenced_run_ids,
  referenced_evidence_ids, tool_activity (migration 010), grounding +
  proposed_actions (migration 016), created_at.
- `session_summaries` — session_id, summary_md, known_facts_json,
  open_questions_json, next_actions_json, findings_json, limitations_json,
  updated_at.
- `session_agent_memory` (migration 013) — id, session_id, kind, text,
  severity, confidence, source_run_id, status, created_at. Agent-authored
  working memory (facts / findings / open questions) fed back into later turns.
- `session_datasets` (migration 014) — id, session_id, dataset_type,
  source_filename, stored_path, duckdb_path, table_name, row_count,
  detected_format, status, created_at. A file the user attaches in the
  conversation, stored against the SESSION (not a run) so the agent analyzes it
  inline via `analyze_uploaded_file`.

## Error triage (migration 009)

- `error_triage_cases` — id, session_id, provider_id, bucket, run_id,
  input_kind, raw_input_redacted, parsed_json, summary, planner_mode (retained
  but no longer written — triage stopped stamping it), status,
  created_at, updated_at.
- `error_triage_findings` — id, case_id, category, severity, confidence, title,
  evidence_json, interpretation, next_checks_json, source_refs_json, created_at.

## App settings (migration 012)

- `app_settings` — key, value, updated_at. A small generic key/value store;
  never stores secrets (those live only in the encrypted local vault).

Every `*_json` / `*_sanitized` / content / redacted column stores only
redaction-passed data: never access/secret keys, session tokens, Authorization
headers, cookies, presigned URLs, model API keys, raw logs / inventory rows, or
chain-of-thought.

## Secret references

A reference is an opaque `keyring://scope/name` string; the secret itself lives
in the encrypted local vault (`security/keyring_store`), never in SQLite.

SQLite may store:

- api_key_ref
- access_key_ref
- secret_key_ref
- session_token_ref

SQLite must not store:

- plaintext API keys
- plaintext access keys
- plaintext secret keys
- plaintext session tokens

## DuckDB

DuckDB stores analytical data:

- Access logs
- Inventory files
- Sampled object metadata
- Derived metrics

## Local files

Run artifact layout:

```text
data/runs/{run_id}/raw/
data/runs/{run_id}/analysis.duckdb
data/runs/{run_id}/report.md
```

Session artifact layout (files a user attaches in the conversation, analyzed
inline by the agent — stored against the session, not a run):

```text
data/sessions/{session_id}/raw/{filename}      # the uploaded file
data/sessions/{session_id}/{dataset_id}.duckdb # per-dataset analysis engine
```

Paths recorded in SQLite (`stored_path`, `duckdb_path`, `report_path`) are stored
relative to the data dir (see `config.rel_path`) so absolute paths — which may
contain a username — never land in `tool_calls` / `audit_logs`.
