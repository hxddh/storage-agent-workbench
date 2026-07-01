"""SQLite schema migrations.

A migration is an ``(version, name, sql)`` triple. The runner records applied
versions in ``schema_migrations`` and applies any pending migrations in order,
each inside its own transaction. Migrations are append-only: never edit a
migration that has shipped; add a new one instead.

Phase 02 creates the app-metadata tables. No analytical (DuckDB) data and no
secrets are stored here — only ``keyring://`` references for secrets.
"""

from __future__ import annotations

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
        conn.executescript(sql)
        conn.execute(
            "INSERT INTO schema_migrations (version, name, applied_at) "
            "VALUES (?, ?, datetime('now'))",
            (version, name),
        )
        conn.commit()
        count += 1
    return count
