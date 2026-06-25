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

# Ordered list of migrations. Append new ones; never edit shipped entries.
MIGRATIONS: list[tuple[int, str, str]] = [
    (1, "initial_schema", _M001),
    (2, "tool_calls_nullable_run", _M002),
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
