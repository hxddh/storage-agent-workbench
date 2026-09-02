"""SQLite schema migrations.

A migration is an ``(version, name, sql)`` triple. The runner records applied
versions in ``schema_migrations`` and applies any pending migrations in order,
each inside its own transaction. Migrations are append-only: never edit a
migration that has shipped; add a new one instead.

Phase 02 creates the app-metadata tables. No analytical (DuckDB) data and no
secrets are stored here — only ``keyring://`` references for secrets.
"""

from __future__ import annotations

import re
import sqlite3

# --- Migration 001: initial app-metadata schema -----------------------------

_M001 = """
CREATE TABLE IF NOT EXISTS model_providers (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    provider_type TEXT NOT NULL,
    base_url      TEXT,
    model         TEXT,
    api_key_ref   TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cloud_providers (
    id                   TEXT PRIMARY KEY,
    name                 TEXT NOT NULL,
    provider_type        TEXT NOT NULL,
    endpoint_url         TEXT,
    region               TEXT,
    addressing_style     TEXT,
    signature_version    TEXT,
    access_key_ref       TEXT,
    secret_key_ref       TEXT,
    session_token_ref    TEXT,
    mode                 TEXT NOT NULL DEFAULT 'readonly',
    allowed_buckets_json  TEXT NOT NULL DEFAULT '[]',
    allowed_prefixes_json TEXT NOT NULL DEFAULT '[]',
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
    id            TEXT PRIMARY KEY,
    run_type      TEXT NOT NULL,
    title         TEXT,
    status        TEXT NOT NULL DEFAULT 'created',
    provider_id   TEXT,
    bucket        TEXT,
    user_prompt   TEXT,
    final_summary TEXT,
    report_path   TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    id         TEXT PRIMARY KEY,
    run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    role       TEXT NOT NULL,
    content    TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_calls (
    id                    TEXT PRIMARY KEY,
    run_id                TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    tool_name             TEXT NOT NULL,
    input_json_sanitized  TEXT,
    output_json_sanitized TEXT,
    status                TEXT,
    duration_ms           INTEGER,
    created_at            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approval_events (
    id                   TEXT PRIMARY KEY,
    run_id               TEXT REFERENCES runs(id) ON DELETE CASCADE,
    action               TEXT NOT NULL,
    decision             TEXT NOT NULL,
    detail_json_sanitized TEXT,
    created_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id                    TEXT PRIMARY KEY,
    run_id                TEXT,
    event_type            TEXT NOT NULL,
    payload_json_sanitized TEXT,
    created_at            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS datasets (
    id          TEXT PRIMARY KEY,
    run_id      TEXT REFERENCES runs(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,
    source_path TEXT,
    row_count   INTEGER,
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
    id          TEXT PRIMARY KEY,
    run_id      TEXT REFERENCES runs(id) ON DELETE CASCADE,
    report_path TEXT NOT NULL,
    format      TEXT NOT NULL DEFAULT 'markdown',
    created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_run     ON messages(run_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_run   ON tool_calls(run_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_event ON audit_logs(event_type);
"""

# --- Migration 002: allow tool_calls without a run ---------------------------
#
# Phase 03 introduces ad-hoc tool invocations (e.g. Test Connection) that are
# not attached to an Analysis Run. Relax tool_calls.run_id to be nullable. The
# table is rebuilt (SQLite cannot drop a NOT NULL constraint in place); this is
# data-preserving via the INSERT ... SELECT copy.

_M002 = """
PRAGMA foreign_keys = OFF;

CREATE TABLE tool_calls_new (
    id                    TEXT PRIMARY KEY,
    run_id                TEXT REFERENCES runs(id) ON DELETE CASCADE,
    tool_name             TEXT NOT NULL,
    input_json_sanitized  TEXT,
    output_json_sanitized TEXT,
    status                TEXT,
    duration_ms           INTEGER,
    created_at            TEXT NOT NULL
);

INSERT INTO tool_calls_new
    SELECT id, run_id, tool_name, input_json_sanitized, output_json_sanitized,
           status, duration_ms, created_at
    FROM tool_calls;

DROP TABLE tool_calls;
ALTER TABLE tool_calls_new RENAME TO tool_calls;

CREATE INDEX IF NOT EXISTS idx_tool_calls_run  ON tool_calls(run_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_name ON tool_calls(tool_name);

PRAGMA foreign_keys = ON;
"""

# --- Migration 003: store the optional prefix scope on a run -----------------

_M003 = """
ALTER TABLE runs ADD COLUMN prefix TEXT;
"""

# --- Migration 004: richer datasets metadata (Phase 05) ----------------------
#
# Rebuild ``datasets`` to carry the metadata an analysis dataset needs:
# dataset_type, name, source_filename, stored_path, duckdb_path, table_name,
# row_count, status. Data-preserving copy from the old (kind, source_path)
# columns. Table rebuild because SQLite cannot add NOT NULL columns in place.

_M004 = """
PRAGMA foreign_keys = OFF;

CREATE TABLE datasets_new (
    id              TEXT PRIMARY KEY,
    run_id          TEXT REFERENCES runs(id) ON DELETE CASCADE,
    dataset_type    TEXT NOT NULL,
    name            TEXT,
    source_filename TEXT,
    stored_path     TEXT,
    duckdb_path     TEXT,
    table_name      TEXT,
    row_count       INTEGER,
    status          TEXT NOT NULL DEFAULT 'uploaded',
    created_at      TEXT NOT NULL
);

INSERT INTO datasets_new
    (id, run_id, dataset_type, name, source_filename, stored_path,
     duckdb_path, table_name, row_count, status, created_at)
    SELECT id, run_id, kind, NULL, NULL, source_path,
           NULL, NULL, row_count, 'imported', created_at
    FROM datasets;

DROP TABLE datasets;
ALTER TABLE datasets_new RENAME TO datasets;

CREATE INDEX IF NOT EXISTS idx_datasets_run ON datasets(run_id);

PRAGMA foreign_keys = ON;
"""

# --- Migration 005: planner mode on runs (Phase 07) --------------------------

_M005 = """
ALTER TABLE runs ADD COLUMN planner_mode TEXT NOT NULL DEFAULT 'deterministic';
"""

# --- Migration 006: account discovery (Phase 14) -----------------------------
#
# Adds a generic per-run ``options_json`` (bounded discovery options like
# max_buckets / include / exclude — never secrets) and the account-discovery
# result tables. Every *_json_sanitized column stores ONLY redaction-passed JSON:
# never AK/SK/session token/Authorization/cookies/presigned URLs/model keys.

_M006 = """
ALTER TABLE runs ADD COLUMN options_json TEXT;

CREATE TABLE IF NOT EXISTS account_snapshots (
    id                     TEXT PRIMARY KEY,
    run_id                 TEXT REFERENCES runs(id) ON DELETE CASCADE,
    provider_id            TEXT,
    bucket_count           INTEGER NOT NULL DEFAULT 0,
    visible_count          INTEGER NOT NULL DEFAULT 0,
    processed_count        INTEGER NOT NULL DEFAULT 0,
    truncated              INTEGER NOT NULL DEFAULT 0,
    list_status            TEXT,
    summary_json_sanitized TEXT,
    created_at             TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_snapshot_buckets (
    id            TEXT PRIMARY KEY,
    snapshot_id   TEXT REFERENCES account_snapshots(id) ON DELETE CASCADE,
    run_id        TEXT,
    provider_id   TEXT,
    bucket_name   TEXT,
    region        TEXT,
    access_status TEXT,
    created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bucket_config_snapshots (
    id                            TEXT PRIMARY KEY,
    snapshot_id                   TEXT REFERENCES account_snapshots(id) ON DELETE CASCADE,
    run_id                        TEXT,
    provider_id                   TEXT,
    bucket_name                   TEXT,
    config_summary_json_sanitized TEXT,
    created_at                    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence_sources (
    id                    TEXT PRIMARY KEY,
    snapshot_id           TEXT REFERENCES account_snapshots(id) ON DELETE CASCADE,
    run_id                TEXT,
    provider_id           TEXT,
    bucket_name           TEXT,
    source_type           TEXT,
    status                TEXT,
    detail_json_sanitized TEXT,
    created_at            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_account_snapshots_run ON account_snapshots(run_id);
CREATE INDEX IF NOT EXISTS idx_account_buckets_snap  ON account_snapshot_buckets(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_bucket_config_snap    ON bucket_config_snapshots(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_evidence_sources_snap ON evidence_sources(snapshot_id);
"""

# --- Migration 007: managed evidence import (Phase 15) -----------------------
#
# Records the bounded, confirmation-gated import of evidence files (inventory /
# access logs) discovered by account_discovery (Phase 14). Every text column
# (bucket / prefix / object key / warnings) is redaction-passed before storage:
# never AK/SK/session token/Authorization/cookies/presigned URL/model key.

_M007 = """
CREATE TABLE IF NOT EXISTS evidence_imports (
    id                   TEXT PRIMARY KEY,
    provider_id          TEXT,
    account_run_id       TEXT,
    snapshot_id          TEXT,
    source_type          TEXT NOT NULL,
    source_bucket        TEXT,
    source_prefix        TEXT,
    evidence_ref         TEXT,
    format               TEXT,
    fmt_schema           TEXT,
    plan_source          TEXT,
    max_files            INTEGER NOT NULL DEFAULT 0,
    max_bytes            INTEGER NOT NULL DEFAULT 0,
    time_range_start     TEXT,
    time_range_end       TEXT,
    planned_file_count   INTEGER NOT NULL DEFAULT 0,
    planned_total_bytes  INTEGER NOT NULL DEFAULT 0,
    selected_file_count  INTEGER NOT NULL DEFAULT 0,
    selected_total_bytes INTEGER NOT NULL DEFAULT 0,
    status               TEXT NOT NULL DEFAULT 'planned',
    analysis_run_id      TEXT,
    warnings_json        TEXT,
    created_at           TEXT NOT NULL,
    confirmed_at         TEXT
);

CREATE TABLE IF NOT EXISTS evidence_import_files (
    id          TEXT PRIMARY KEY,
    import_id   TEXT REFERENCES evidence_imports(id) ON DELETE CASCADE,
    object_key  TEXT,
    size_bytes  INTEGER NOT NULL DEFAULT 0,
    kind        TEXT,
    selected    INTEGER NOT NULL DEFAULT 0,
    status      TEXT NOT NULL DEFAULT 'planned',
    created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_evidence_imports_run ON evidence_imports(account_run_id);
CREATE INDEX IF NOT EXISTS idx_evidence_files_import ON evidence_import_files(import_id);
"""

# --- Migration 008: session workspace context (Phase 16) ---------------------
#
# Session = persistent working context that links runs (auditable execution
# units), evidence references, evidence-driven findings, a deterministic
# summary, and a lightweight message thread. This is NOT a project-management /
# kanban / ticketing system: there is no assignee, board, column, due date,
# label, or multi-user/permission model. Every *_json / content column is
# redaction-passed: never AK/SK/session token/Authorization/cookies/presigned
# URL/model key, and never raw logs / raw inventory rows / chain-of-thought.

_M008 = """
ALTER TABLE runs ADD COLUMN session_id TEXT;

CREATE TABLE IF NOT EXISTS sessions (
    id             TEXT PRIMARY KEY,
    title          TEXT NOT NULL,
    goal           TEXT,
    provider_id    TEXT,
    primary_bucket TEXT,
    status         TEXT NOT NULL DEFAULT 'active',
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_runs (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    role       TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_evidence_refs (
    id            TEXT PRIMARY KEY,
    session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    source_type   TEXT NOT NULL,
    source_id     TEXT,
    source_run_id TEXT,
    summary_json  TEXT,
    created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_findings (
    id             TEXT PRIMARY KEY,
    session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    source_run_id  TEXT,
    category       TEXT,
    severity       TEXT,
    confidence     TEXT,
    kind           TEXT,
    title          TEXT,
    evidence_json  TEXT,
    interpretation TEXT,
    status         TEXT NOT NULL DEFAULT 'active',
    created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_messages (
    id                    TEXT PRIMARY KEY,
    session_id            TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role                  TEXT NOT NULL,
    content               TEXT,
    referenced_run_ids    TEXT,
    referenced_evidence_ids TEXT,
    created_at            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_summaries (
    session_id        TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    summary_md        TEXT,
    known_facts_json  TEXT,
    open_questions_json TEXT,
    next_actions_json TEXT,
    findings_json     TEXT,
    limitations_json  TEXT,
    updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_runs_session     ON session_runs(session_id);
CREATE INDEX IF NOT EXISTS idx_session_findings_session ON session_findings(session_id);
CREATE INDEX IF NOT EXISTS idx_session_messages_session ON session_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_runs_session             ON runs(session_id);
"""

# --- Migration 009: error triage assistant (Phase 18) ------------------------
#
# Session-centered S3 / object-storage error triage. A case stores ONLY the
# redacted pasted input and sanitized parsed signals + findings — never AK/SK/
# session token/Authorization/cookies/presigned URL/model key, never the full
# raw sensitive log, and never chain-of-thought. This is NOT a ticketing system:
# no assignee, status board, due date, or workflow state machine.

_M009 = """
CREATE TABLE IF NOT EXISTS error_triage_cases (
    id                 TEXT PRIMARY KEY,
    session_id         TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    provider_id        TEXT,
    bucket             TEXT,
    run_id             TEXT,
    input_kind         TEXT NOT NULL,
    raw_input_redacted TEXT,
    parsed_json        TEXT,
    summary            TEXT,
    planner_mode       TEXT NOT NULL DEFAULT 'deterministic',
    status             TEXT NOT NULL DEFAULT 'parsed',
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS error_triage_findings (
    id              TEXT PRIMARY KEY,
    case_id         TEXT REFERENCES error_triage_cases(id) ON DELETE CASCADE,
    category        TEXT,
    severity        TEXT,
    confidence      TEXT,
    title           TEXT,
    evidence_json   TEXT,
    interpretation  TEXT,
    next_checks_json TEXT,
    source_refs_json TEXT,
    created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_triage_cases_session ON error_triage_cases(session_id);
CREATE INDEX IF NOT EXISTS idx_triage_findings_case ON error_triage_findings(case_id);
"""

# Persist the read-only tool calls the in-chat agent made for an assistant turn,
# so the conversation can show "ran list_buckets → 96 buckets" and it survives
# reloads. JSON array of {tool, target, result}; sanitized, no secrets.
_M010 = """
ALTER TABLE session_messages ADD COLUMN tool_activity TEXT;
"""

# Session management: pin sessions to the top of the rail. 0 = unpinned.
_M011 = """
ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
"""

# Global app settings as a small generic key/value store. Never stores secrets
# (those live only in the encrypted local vault — see security.keyring_store,
# NOT the OS keychain).
_M012 = """
CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"""

# Agent-authored working memory for a session: facts/findings/open-questions the
# in-chat agent records itself as it investigates, so its discoveries persist
# across turns (the deterministic summary in session_findings/session_summaries
# is rebuilt from run artifacts and would otherwise wipe them). Sanitized, no
# secrets, no raw rows — same redaction as everything else the agent emits.
_M013 = """
CREATE TABLE IF NOT EXISTS session_agent_memory (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,
    text        TEXT NOT NULL,
    severity    TEXT,
    confidence  TEXT,
    source_run_id TEXT,
    status      TEXT NOT NULL DEFAULT 'active',
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_agent_memory_session ON session_agent_memory(session_id);
"""

# Session-scoped uploaded datasets (agent-native file analysis). A file the user
# attaches in the conversation is stored against the SESSION (not a run) so the
# in-chat agent can analyze it as a tool and answer inline, instead of the upload
# forcing a fixed deterministic analysis run. status: 'uploaded' → 'imported'.
# Mirrors the run-scoped ``datasets`` shape but keyed to a session and cascades
# on session delete. No secrets / no raw rows persist here beyond the file path.
_M014 = """
CREATE TABLE IF NOT EXISTS session_datasets (
    id              TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    dataset_type    TEXT NOT NULL,
    source_filename TEXT,
    stored_path     TEXT,
    duckdb_path     TEXT,
    table_name      TEXT,
    row_count       INTEGER,
    detected_format TEXT,
    status          TEXT NOT NULL DEFAULT 'uploaded',
    created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_datasets_session ON session_datasets(session_id);
"""

# Run origin: who initiated a run. 'agent' runs are the conversational agent's own
# read-only survey/review tools (account survey, config review) — internal compute
# that persists a profile but is NEVER surfaced as a structured run card in the
# thread (the agent narrates the result). 'user' runs are explicitly requested
# auditable reports. This makes the agent the sole conversational surface while
# keeping the deterministic engines as the security/reproducibility floor.
_M015 = """
ALTER TABLE runs ADD COLUMN origin TEXT NOT NULL DEFAULT 'user';
"""

# Persist an assistant turn's grounding + proposed next actions on the message
# row, so they survive a reload (previously they only rode the transient SSE
# `done` event and were lost when the thread was re-fetched — a historical turn
# then couldn't show "why it said that"). Both are sanitized JSON:
# grounding = {evidence_used, evidence_gaps, skills_used}; proposed_actions =
# the same normalized proposal list the `done` event carries. No secrets/raw rows.
_M016 = """
ALTER TABLE session_messages ADD COLUMN grounding TEXT;
ALTER TABLE session_messages ADD COLUMN proposed_actions TEXT;
"""

# Optional explicit context window (tokens) for a model provider. The agent's
# per-turn depth budgets (model_budget) scale with the active model's window;
# when a newly-shipped model isn't in the built-in substring table it falls to a
# conservative default and gets throttled. This lets an operator declare the real
# window so a large-context model is used to its full depth. NULL → use the table.
_M017 = """
ALTER TABLE model_providers ADD COLUMN context_window INTEGER;
"""

# Optional operator-declared MAX OUTPUT tokens for a model provider. The
# completion budget is clamped to the model's provider max-output (a substring
# table) so we never request a max_tokens the endpoint 400s on; but an unknown or
# third-party-compatible model falls to a default that some endpoints reject. This
# lets an operator declare the real cap. NULL → use the table. Mirrors
# context_window (migration 017).
_M019 = """
ALTER TABLE model_providers ADD COLUMN max_output_tokens INTEGER;
"""

# Indexes on created_at for the startup retention prune (data_maintenance):
# audit_logs and ad-hoc (run_id IS NULL) tool_calls are aged out by created_at,
# and both tables grow to the point where a full scan per boot would be costly.
_M018 = """
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_tool_calls_created ON tool_calls(created_at);
"""

# Session-scoped observability: the agent's own tool calls and audit rows were
# only ever linked to a RUN, and a conversational turn has no run — so a session's
# activity was recorded (rule 17) but could not be queried back for the session it
# belonged to. Nullable columns + indexes; existing rows keep NULL and simply
# don't appear in per-session views.
_M020 = """
ALTER TABLE audit_logs ADD COLUMN session_id TEXT;
ALTER TABLE tool_calls ADD COLUMN session_id TEXT;
CREATE INDEX IF NOT EXISTS idx_audit_logs_session ON audit_logs(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id, created_at);
"""

# What one conversational turn cost: wall-clock, tool calls, and — when the
# provider reports it — tokens. Its own table rather than columns on messages
# because token counts are frequently ABSENT (many OpenAI-compatible endpoints
# omit usage on streamed responses); a nullable column set would make
# "unavailable" indistinguishable from a measured zero. A missing row, or a NULL
# token column, means not reported — never free.
_M021 = """
CREATE TABLE IF NOT EXISTS turn_metrics (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  message_id TEXT,
  model TEXT,
  requests INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  duration_ms INTEGER,
  tool_calls INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_turn_metrics_session ON turn_metrics(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_turn_metrics_message ON turn_metrics(message_id);
"""

_M022 = """
ALTER TABLE turn_metrics ADD COLUMN cached_input_tokens INTEGER;
ALTER TABLE turn_metrics ADD COLUMN reasoning_tokens INTEGER;
"""

# v0.54.0: what the turn's own governor did. NOT provider-reported tokens — the
# workbench's per-turn ceiling and the identical calls it answered from the
# conversation instead of re-running. Persisted so the footer still tells the
# truth after a reload, and NULL on turns recorded before this shipped.
_M023 = """
ALTER TABLE turn_metrics ADD COLUMN budget_tokens INTEGER;
ALTER TABLE turn_metrics ADD COLUMN repeat_calls_avoided INTEGER;
"""

# Whether an uploaded dataset hit the ingest row cap, and what the cap was.
#
# The import already computed both, and the analysis tool already told the model
# "these metrics are a lower bound" — but only on the call that DID the import.
# The fact lived on that call's return value and nowhere else, so every later
# turn re-read the same truncated table and described it as the whole file.
# Persisting it on the row makes the caveat a property of the dataset rather
# than of one lucky call.
#
# The UPDATE is the other half, and it is not optional. Rows imported BEFORE
# this migration have NULL — unknown — and nothing would ever resolve it:
# `_ensure_imported` reuses the built table while the row says 'imported', so
# the importer never runs again and a large upload from a previous version
# would keep answering uncaveated, forever. Sending those rows back to
# 'uploaded' costs one re-import each (local DuckDB, once) and establishes the
# truth instead of preserving an unknown that reads as "fine".
_M024 = """
ALTER TABLE session_datasets ADD COLUMN truncated INTEGER;
ALTER TABLE session_datasets ADD COLUMN ingest_cap INTEGER;
UPDATE session_datasets SET status = 'uploaded' WHERE status = 'imported';
"""

_M025 = """
ALTER TABLE datasets ADD COLUMN truncated INTEGER;
ALTER TABLE datasets ADD COLUMN ingest_cap INTEGER;
"""

# --- Migration 026: durable Agent Task runtime (v0.94) -----------------------
#
# The Agent Task becomes a DURABLE DOMAIN OBJECT and Execution becomes a
# first-class durable object with a real lifecycle — the task runtime stops
# being a per-HTTP-request "turn runner":
#
#   agent_tasks           the product task object. Its id EQUALS the
#                         compatibility session id (1:1, FK-cascaded), so every
#                         existing adapter/API keeps addressing the same thing
#                         while the task carries its own durable lifecycle
#                         (`ready` / `working` / `needs_decision` /
#                         `needs_attention` / `archived`).
#   task_executions       one unit of delegated work (a Direction being
#                         executed). Lifecycle: queued → running →
#                         completed | failed | cancelled | interrupted.
#                         `interrupted` is what a sidecar restart stamps on
#                         executions a dead process left behind — recovery is an
#                         explicit durable state, never a silent "nothing
#                         running". `turn_id` keeps client idempotency
#                         (streaming↔fallback dedup) durable instead of
#                         in-process.
#   execution_events      append-only STRUCTURED progress (status transitions,
#                         tool started/completed, steer received/applied,
#                         decision opened, work result recorded). This is what
#                         the UI derives live/replayed progress from — never
#                         assistant prose. Sanitized payloads only; transient
#                         answer deltas are NOT persisted (bounded stream, no
#                         chain-of-thought, no unbounded growth).
#   work_results          the durable output of an execution. Content stays on
#                         the compatibility session_messages row (message_id
#                         links it); the runtime metadata — grounding,
#                         proposals, stopped/cut-short — lives here.
#   task_decisions        first-class durable Decision objects, created from
#                         real backend proposals that gate data-moving or
#                         artifact-producing work. pending | approved |
#                         declined | superseded, with an audit-friendly
#                         resolution trail. Task decision state reads from
#                         here, never from re-parsing the latest message.
#   task_artifacts        unified first-class Artifact index: reports, evidence
#                         imports, analyses — each row points at the durable
#                         thing (ref_kind/ref_id) rather than duplicating it.
#   task_context_versions typed, versioned Storage Task Context (machine state:
#                         provider scope, buckets/prefixes in focus, evidence
#                         on hand). Recovering a task never requires replaying
#                         chat.
#
# Backfill: every existing session becomes an agent_task, and every historical
# assistant message becomes a work_result so old investigations keep their Work
# Result history. Pending decisions are seeded from each session's LATEST
# assistant message only (historical proposals are audit history, not current
# blockers — the same rule the old projection applied), and only for the
# confirmation-gated types. All *_json_sanitized columns store redaction-passed
# JSON only — never secrets, raw rows, or chain-of-thought.

_M026 = """
CREATE TABLE IF NOT EXISTS agent_tasks (
    id                  TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    title               TEXT NOT NULL,
    goal                TEXT,
    status              TEXT NOT NULL DEFAULT 'ready',
    active_execution_id TEXT,
    context_version     INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);

INSERT INTO agent_tasks (id, title, goal, status, created_at, updated_at)
    SELECT id, title, goal, 'ready', created_at, updated_at FROM sessions;

CREATE TABLE IF NOT EXISTS task_executions (
    id           TEXT PRIMARY KEY,
    task_id      TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
    turn_id      TEXT,
    direction    TEXT,
    kind         TEXT NOT NULL DEFAULT 'direction',
    status       TEXT NOT NULL DEFAULT 'queued',
    error        TEXT,
    resumed_from TEXT,
    steer_count  INTEGER NOT NULL DEFAULT 0,
    work_result_id TEXT,
    created_at   TEXT NOT NULL,
    started_at   TEXT,
    finished_at  TEXT,
    updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_executions_task ON task_executions(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_task_executions_status ON task_executions(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_executions_turn
    ON task_executions(task_id, turn_id) WHERE turn_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS execution_events (
    seq          INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id TEXT NOT NULL,
    task_id      TEXT NOT NULL,
    event_type   TEXT NOT NULL,
    payload_json_sanitized TEXT,
    created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_execution_events_exec ON execution_events(execution_id, seq);
CREATE INDEX IF NOT EXISTS idx_execution_events_task ON execution_events(task_id, seq);

CREATE TABLE IF NOT EXISTS work_results (
    id           TEXT PRIMARY KEY,
    task_id      TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
    execution_id TEXT,
    message_id   TEXT,
    kind         TEXT NOT NULL DEFAULT 'answer',
    stopped      INTEGER NOT NULL DEFAULT 0,
    cut_short    TEXT,
    grounding_json_sanitized TEXT,
    proposals_json_sanitized TEXT,
    created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_work_results_task ON work_results(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_work_results_exec ON work_results(execution_id);

INSERT INTO work_results
    (id, task_id, execution_id, message_id, kind, stopped,
     grounding_json_sanitized, proposals_json_sanitized, created_at)
    SELECT lower(hex(randomblob(16))), m.session_id, NULL, m.id, 'answer', 0,
           m.grounding, m.proposed_actions, m.created_at
    FROM session_messages m
    WHERE m.role = 'assistant';

CREATE TABLE IF NOT EXISTS task_decisions (
    id           TEXT PRIMARY KEY,
    task_id      TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
    execution_id TEXT,
    work_result_id TEXT,
    action_type  TEXT NOT NULL,
    title        TEXT,
    reason       TEXT,
    proposal_json_sanitized TEXT,
    status       TEXT NOT NULL DEFAULT 'pending',
    resolution_note TEXT,
    created_at   TEXT NOT NULL,
    resolved_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_decisions_task ON task_decisions(task_id, status);

INSERT INTO task_decisions
    (id, task_id, execution_id, work_result_id, action_type, title, reason,
     proposal_json_sanitized, status, created_at)
    SELECT lower(hex(randomblob(16))), m.session_id, NULL, NULL,
           json_extract(je.value, '$.action_type'),
           json_extract(je.value, '$.title'),
           json_extract(je.value, '$.reason'),
           je.value, 'pending', m.created_at
    FROM session_messages m
    JOIN (
        SELECT session_id, MAX(rowid) AS latest_rowid
        FROM session_messages WHERE role = 'assistant' GROUP BY session_id
    ) latest ON latest.latest_rowid = m.rowid,
    json_each(m.proposed_actions) je
    WHERE json_valid(m.proposed_actions)
      AND json_extract(je.value, '$.requires_confirmation') = 1
      AND json_extract(je.value, '$.action_type') IN
          ('plan_inventory_import', 'plan_access_log_import', 'generate_session_report');

UPDATE agent_tasks SET status = 'needs_decision'
    WHERE id IN (SELECT DISTINCT task_id FROM task_decisions WHERE status = 'pending');

CREATE TABLE IF NOT EXISTS task_artifacts (
    id            TEXT PRIMARY KEY,
    task_id       TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
    execution_id  TEXT,
    artifact_type TEXT NOT NULL,
    title         TEXT,
    ref_kind      TEXT,
    ref_id        TEXT,
    format        TEXT,
    summary       TEXT,
    created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_artifacts_task ON task_artifacts(task_id, created_at);

CREATE TABLE IF NOT EXISTS task_context_versions (
    task_id      TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
    version      INTEGER NOT NULL,
    context_json_sanitized TEXT NOT NULL,
    updated_by_execution_id TEXT,
    created_at   TEXT NOT NULL,
    PRIMARY KEY (task_id, version)
);
"""

# --- Migration 027: v0.96 optimization copilot --------------------------------
# Price table (ordinary config), versioned remediation plans, task baselines,
# per-task revisit schedules, and optional artifact status/payload. Never edit
# shipped 026.

_M027 = """
CREATE TABLE IF NOT EXISTS storage_price_table (
    id          TEXT PRIMARY KEY,
    confirmed   INTEGER NOT NULL DEFAULT 0,
    rates_json  TEXT NOT NULL,
    note        TEXT,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS remediation_plans (
    id                         TEXT PRIMARY KEY,
    task_id                    TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
    execution_id               TEXT,
    version                    INTEGER NOT NULL,
    status                     TEXT NOT NULL,
    title                      TEXT,
    plan_json_sanitized        TEXT NOT NULL,
    simulation_json_sanitized  TEXT,
    created_at                 TEXT NOT NULL,
    updated_at                 TEXT NOT NULL,
    UNIQUE (task_id, version)
);
CREATE INDEX IF NOT EXISTS idx_remediation_plans_task ON remediation_plans(task_id, version);

CREATE TABLE IF NOT EXISTS task_baselines (
    id                        TEXT PRIMARY KEY,
    task_id                   TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
    execution_id              TEXT,
    version                   INTEGER NOT NULL,
    snapshot_json_sanitized   TEXT NOT NULL,
    context_version           INTEGER,
    created_at                TEXT NOT NULL,
    UNIQUE (task_id, version)
);
CREATE INDEX IF NOT EXISTS idx_task_baselines_task ON task_baselines(task_id, version);

CREATE TABLE IF NOT EXISTS task_revisit_schedules (
    task_id            TEXT PRIMARY KEY REFERENCES agent_tasks(id) ON DELETE CASCADE,
    enabled            INTEGER NOT NULL DEFAULT 1,
    interval_days      INTEGER NOT NULL,
    last_revisit_at    TEXT,
    next_due_at        TEXT,
    last_catchup_note  TEXT,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL
);

ALTER TABLE task_artifacts ADD COLUMN status TEXT;
ALTER TABLE task_artifacts ADD COLUMN payload_json_sanitized TEXT;
"""


# --- Migration 028: v1.10 native agent — task titles + reasoning effort -------
# Two nullable columns, no rewrites, no backfill:
#   sessions.title_source           'agent' when the runtime titled the task
#                                   after its first Work Result, 'user' after a
#                                   rename. NULL = the deterministic seed title.
#                                   A user rename wins forever (the runtime
#                                   never titles a 'user' row again).
#   model_providers.reasoning_effort 'low' | 'medium' | 'high' | NULL. Passed
#                                   to the model call only for providers whose
#                                   model is known-reasoning (model_budget).
# Never edit shipped 027.

_M028 = """
ALTER TABLE sessions ADD COLUMN title_source TEXT;
ALTER TABLE model_providers ADD COLUMN reasoning_effort TEXT;
"""

# --- Migration 029: v1.11 native agent — turn items + inline approvals ---------
# Three nullable/defaulted columns, no rewrites, no backfill:
#   session_messages.turn_items   JSON list of the assistant turn's ordered
#                                 transcript items ({kind: message|tool, …}):
#                                 the commentary segments the model wrote
#                                 before acting and the tool rows between them.
#                                 The answer itself stays in `content`. NULL on
#                                 pre-1.11 rows (rendered as answer-only).
#   task_decisions.kind           'approval' for a Decision a gated TOOL raised
#                                 inside a running execution (the execution
#                                 waits on it); 'proposal' for pre-1.11 rows.
#   task_decisions.scope          how an approval was granted: 'once' | 'task'
#                                 ('task' auto-approves later calls of the same
#                                 action_type in that task). NULL = declined
#                                 or not yet resolved.
# Never edit shipped 028.

_M029 = """
ALTER TABLE session_messages ADD COLUMN turn_items TEXT;
ALTER TABLE task_decisions ADD COLUMN kind TEXT NOT NULL DEFAULT 'proposal';
ALTER TABLE task_decisions ADD COLUMN scope TEXT;
"""

# Ordered list of migrations. Append new ones; never edit shipped entries.
MIGRATIONS: list[tuple[int, str, str]] = [
    (1, "initial_schema", _M001),
    (2, "tool_calls_nullable_run", _M002),
    (3, "runs_add_prefix", _M003),
    (4, "datasets_metadata", _M004),
    (5, "runs_add_planner_mode", _M005),
    (6, "account_discovery", _M006),
    (7, "managed_evidence_import", _M007),
    (8, "session_workspace_context", _M008),
    (9, "error_triage", _M009),
    (10, "session_message_tool_activity", _M010),
    (11, "sessions_pinned", _M011),
    (12, "app_settings", _M012),
    (13, "session_agent_memory", _M013),
    (14, "session_datasets", _M014),
    (15, "runs_add_origin", _M015),
    (16, "session_message_grounding", _M016),
    (17, "model_provider_context_window", _M017),
    (18, "retention_indexes", _M018),
    (19, "model_provider_max_output", _M019),
    (20, "session_scoped_observability", _M020),
    (21, "turn_metrics", _M021),
    # v0.53.0 — the two numbers that actually explain a turn's cost. The SDK has
    # reported both since v0.45.0's usage capture; nothing read them, so a
    # cached prefix (typically an order of magnitude cheaper) and a reasoning
    # model's invisible output were indistinguishable from ordinary spend.
    (22, "turn_metrics_token_details", _M022),
    (23, "turn_metrics_budget", _M023),
    (24, "session_datasets_truncation", _M024),
    (25, "datasets_truncation", _M025),
    # v0.94.0 — the durable Agent Task runtime: Agent Task and Execution become
    # durable domain objects, progress becomes structured durable events,
    # Decision/Artifact/Work Result become first-class rows, and the Storage
    # Task Context is typed + versioned. See the _M026 comment block.
    (26, "durable_task_runtime", _M026),
    # v0.96.0 — cost/lifecycle simulator, remediation-plan artifacts, versioned
    # baselines + Drift, per-task revisit schedules. Append-only.
    (27, "optimization_copilot", _M027),
    # v1.10.0 — runtime-generated task titles (user rename wins) and per-provider
    # reasoning effort for known-reasoning models. Append-only.
    (28, "native_agent_titles_effort", _M028),
    # v1.11.0 — Codex-style turns: ordered turn items on the assistant message,
    # and Decisions raised inline by gated tools (kind/scope). Append-only.
    (29, "native_agent_turn_items_approvals", _M029),
]


def apply_migrations(conn: sqlite3.Connection) -> int:
    """Apply any pending migrations. Returns the number applied."""
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version    INTEGER PRIMARY KEY,
            name       TEXT NOT NULL,
            applied_at TEXT NOT NULL
        )
        """
    )
    conn.commit()

    applied = {
        row[0] for row in conn.execute("SELECT version FROM schema_migrations")
    }

    count = 0
    for version, name, sql in MIGRATIONS:
        if version in applied:
            continue
        _apply_one(conn, sql)
        conn.execute(
            "INSERT INTO schema_migrations (version, name, applied_at) "
            "VALUES (?, ?, datetime('now'))",
            (version, name),
        )
        conn.commit()
        count += 1
    return count


# Errors that mean a schema element this migration creates is ALREADY present —
# i.e. the migration was partially applied before a crash (executescript commits
# implicitly and cannot roll back), and its version row was never written. On a
# retry these are safe to skip; a genuinely new error is not swallowed.
#
# OperationalError covers DDL that already ran (a duplicate column, an existing
# table/index). IntegrityError covers a *seed row* an ``INSERT`` re-added on the
# retry — the row is already there from the partial apply, so its unique/primary
# key clash is the same "already applied" signal, not a real violation. Both are
# only ever swallowed on the recovery path, never on a first, clean apply.
_IDEMPOTENT_ERROR_MARKERS = ("duplicate column name", "already exists")
_IDEMPOTENT_INTEGRITY_MARKERS = ("unique constraint failed", "primary key must be unique")


def _is_idempotent(exc: sqlite3.Error) -> bool:
    text = str(exc).lower()
    if isinstance(exc, sqlite3.IntegrityError):
        return any(m in text for m in _IDEMPOTENT_INTEGRITY_MARKERS)
    return any(m in text for m in _IDEMPOTENT_ERROR_MARKERS)


# Table-rebuild idiom: CREATE <new> / INSERT..SELECT / DROP <final> / RENAME
# <new>→<final>. Used by _M002 (tool_calls) and _M004 (datasets, which also
# RENAMES columns).
_RENAME_RE = re.compile(r"ALTER\s+TABLE\s+(\w+)\s+RENAME\s+TO\s+(\w+)", re.IGNORECASE)


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone() is not None


def _col_sig(conn: sqlite3.Connection, table: str) -> frozenset:
    # (name, type, notnull, pk) — a rebuild that changes ONLY a constraint (e.g.
    # ``_M002`` relaxing ``run_id`` to nullable) leaves column NAMES identical, so
    # a name-set comparison can't tell the un-rebuilt old table from the rebuilt
    # one; the ``notnull`` flag can.
    return frozenset(
        (row[1], row[2], row[3], row[5])
        for row in conn.execute(f"PRAGMA table_info({table})")
    )


def _statements(sql: str) -> list[str]:
    # Migration DDL here has no semicolons inside string literals, so a simple
    # split is safe.
    return [s.strip() for s in sql.split(";") if s.strip()]


def _create_sig(sql: str, table: str) -> frozenset:
    """``(name, notnull)`` per column declared in this migration's ``CREATE TABLE
    <table> (...)``. Parsed from the migration text so the rebuilt shape is known
    even when the ``<new>`` table itself is already gone. Includes ``notnull`` so a
    constraint-only rebuild (``_M002``: ``run_id`` → nullable, names unchanged) is
    distinguishable from the un-rebuilt table. A bare ``PRIMARY KEY`` is NOT treated
    as ``NOT NULL`` — matching SQLite's ``PRAGMA table_info`` for a non-INTEGER PK,
    so this signature compares equal to the live table's."""
    m = re.search(rf"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?{table}\s*\(",
                  sql, re.IGNORECASE)
    if m is None:
        return frozenset()
    # Paren-depth walk to the MATCHING close paren, then a depth-aware comma
    # split. The old non-greedy `\((.*?)\)` + bare `split(",")` silently
    # mis-parsed any column block containing parenthesized commas — a future
    # rebuild with `CHECK (status IN ('a','b'))` or `DEFAULT (strftime(...))`
    # would fragment into bogus tuples, the recovery signature would never
    # match, and the crash-recovery path would replay a non-idempotent rebuild
    # on every boot (a permanent wedge). Migrations are append-only; the parser
    # must not constrain what future ones may contain.
    i, depth = m.end(), 1
    start = i
    while i < len(sql) and depth:
        if sql[i] == "(":
            depth += 1
        elif sql[i] == ")":
            depth -= 1
        i += 1
    if depth:
        return frozenset()
    block = sql[start:i - 1]
    parts: list[str] = []
    buf: list[str] = []
    d = 0
    for ch in block:
        if ch == "(":
            d += 1
        elif ch == ")":
            d -= 1
        if ch == "," and d == 0:
            parts.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
    if buf:
        parts.append("".join(buf))
    sig: set = set()
    for part in parts:
        tok = part.strip().split()
        if tok and tok[0].upper() not in (
            "PRIMARY", "FOREIGN", "UNIQUE", "CHECK", "CONSTRAINT"
        ):
            notnull = 1 if re.search(r"\bNOT\s+NULL\b", part, re.IGNORECASE) else 0
            sig.add((tok[0].strip('"'), notnull))
    return frozenset(sig)


def _name_notnull_sig(conn: sqlite3.Connection, table: str) -> frozenset:
    return frozenset((row[1], row[3]) for row in conn.execute(f"PRAGMA table_info({table})"))


def _recover_table_rebuild(conn: sqlite3.Connection, sql: str) -> bool:
    """Recover a crashed table-rebuild migration (``CREATE <new> / INSERT..SELECT /
    DROP <final> / RENAME <new>→<final>``). Return True if handled (caller returns),
    False if this isn't a rebuild or it should be re-run from scratch.

    Why this is REQUIRED, not an optimization: a rebuild that renames COLUMNS
    (``_M004``: ``kind``→``dataset_type``) has an ``INSERT..SELECT`` naming the OLD
    columns, so once the rename completes a retry's ``executescript`` re-runs that
    copy against the NEW-schema table and raises ``no such column`` / ``no such
    table`` — NOT an idempotent marker, so the migration wedges on EVERY boot and
    the app never starts. The naive fix (tolerating those errors) DROPs the
    populated final table and renames an empty ``<new>`` in — silent data loss. So
    we key off the SCHEMA, not table existence (``executescript`` re-creates an
    empty ``<new>`` before failing, so "both exist" is not a reliable signal):

      - ``<new>`` present, ``<final>`` gone → crashed after DROP, before RENAME; the
        data lives in ``<new>`` → finish the RENAME + trailing indexes/PRAGMA and
        NEVER re-run the CREATE/INSERT (their source table is gone).
      - ``<final>`` already has the REBUILT column set → the rebuild completed
        (crash after RENAME, incl. a fully-applied migration that died before its
        version row was written) → drop any stale empty ``<new>`` and stop.
      - ``<final>`` still has the OLD column set → drop any stale ``<new>`` and let
        the caller re-run the whole rebuild from the intact ``<final>``.
    """
    m = _RENAME_RE.search(sql)
    if m is None:
        return False
    new, final = m.group(1), m.group(2)

    if _table_exists(conn, new) and not _table_exists(conn, final):
        stmts = _statements(sql)
        rename_idx = next(i for i, s in enumerate(stmts) if _RENAME_RE.search(s))
        for stmt in stmts[rename_idx:]:  # RENAME + trailing indexes / PRAGMA only
            try:
                conn.execute(stmt)
            except (sqlite3.OperationalError, sqlite3.IntegrityError) as exc:
                if not _is_idempotent(exc):
                    raise
        conn.commit()
        return True

    if not _table_exists(conn, final):
        return False  # unrecognized state; let the generic replay try

    # <final> exists. Whether the rebuild already ran is told by comparing <final>
    # to the rebuilt shape. When the stale <new> is still present (executescript
    # re-created it before failing) we compare full column SIGNATURES — names
    # alone miss a constraint-only rebuild like _M002 (run_id → nullable). We then
    # DROP the stale <new> so, if not completed, the generic replay re-runs the
    # rebuild from the intact <final>.
    if _table_exists(conn, new):
        completed = _col_sig(conn, final) == _col_sig(conn, new)
        conn.execute(f"DROP TABLE IF EXISTS {new}")  # stale/partial copy
        conn.commit()
        return completed
    # <new> is gone: compare <final> to the rebuilt shape parsed from the migration
    # text — (name, notnull) so a constraint-only rebuild (names unchanged) isn't
    # mistaken for complete. If they disagree, return False so the generic replay
    # re-runs the rebuild from the intact <final>.
    target_sig = _create_sig(sql, new)
    return bool(target_sig) and _name_notnull_sig(conn, final) == target_sig


def _apply_one(conn: sqlite3.Connection, sql: str) -> None:
    """Apply one migration's SQL, recovering from a partial prior application.

    Fast path: a single ``executescript`` (unchanged behavior). If that fails on a
    retry after a mid-migration crash: a table-rebuild is recovered rename-state-
    aware (``_recover_table_rebuild``), and otherwise (ADD COLUMN / IF NOT EXISTS
    migrations) the statements are re-run individually, skipping the ones that
    report the schema element (or seed row) already exists. Any other error
    propagates.
    """
    try:
        conn.executescript(sql)
        return
    except (sqlite3.OperationalError, sqlite3.IntegrityError) as exc:
        # A crashed table-rebuild can fail with a NON-idempotent error (no such
        # table/column) — try the rebuild-aware recovery before deciding to raise.
        if _recover_table_rebuild(conn, sql):
            return
        if not _is_idempotent(exc):
            raise
    # Recovery: replay statement-by-statement, tolerating only the idempotent
    # "already exists / duplicate column / seed row already present" errors.
    # (Migration DDL here has no semicolons inside string literals, so a simple
    # split is safe.)
    for stmt in (s.strip() for s in sql.split(";")):
        if not stmt:
            continue
        try:
            conn.execute(stmt)
        except (sqlite3.OperationalError, sqlite3.IntegrityError) as exc:
            if not _is_idempotent(exc):
                raise
