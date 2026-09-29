"""SQLite schema (v5).

v5 is a fresh schema in a fresh file (`storage-agent.db`); a v4 `app.db` is
never modified — the one-shot importer reads it. Migrations are append-only
from here: never edit a shipped entry, add a new one.

The model in one sentence: a Task is a tree of Turns (a fork is a new branch
from an earlier Turn), and everything that happened in a Turn is an ordered,
append-only stream of Items. The UI, the report, the audit and the trace are
all projections of Items. The estate (buckets, issues, watch) sits beside the
tasks: it is what the work established about the user's storage.
"""

from __future__ import annotations

import re
import sqlite3

_V1 = """
CREATE TABLE settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

-- Model endpoints. The API key lives in the vault; only its keyring:// ref here.
-- api_style: 'responses' (OpenAI Responses API: native tool search, compaction,
-- reasoning summaries) or 'chat' (Chat Completions: every OpenAI-compatible
-- endpoint). Chosen from the provider kind, overridable.
CREATE TABLE model_providers (
    id                 TEXT PRIMARY KEY,
    name               TEXT NOT NULL,
    kind               TEXT NOT NULL,
    base_url           TEXT,
    model              TEXT NOT NULL,
    api_key_ref        TEXT,
    api_style          TEXT NOT NULL DEFAULT 'chat',
    context_window     INTEGER,
    max_output_tokens  INTEGER,
    reasoning_effort   TEXT,
    active             INTEGER NOT NULL DEFAULT 0,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL
);

-- Storage accounts. Credentials live in the vault; scope is enforced server-side.
CREATE TABLE cloud_providers (
    id                    TEXT PRIMARY KEY,
    name                  TEXT NOT NULL,
    provider_type         TEXT NOT NULL,
    endpoint_url          TEXT,
    region                TEXT,
    addressing_style      TEXT,
    signature_version     TEXT,
    access_key_ref        TEXT,
    secret_key_ref        TEXT,
    session_token_ref     TEXT,
    allowed_buckets_json  TEXT NOT NULL DEFAULT '[]',
    allowed_prefixes_json TEXT NOT NULL DEFAULT '[]',
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL
);

CREATE TABLE tasks (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    title_source  TEXT NOT NULL DEFAULT 'seed',   -- seed | agent | user
    head_turn_id  TEXT,                            -- the turn the task currently continues from
    origin        TEXT NOT NULL DEFAULT 'user',   -- user | watch | quick_ask
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

-- A Turn is one Direction and the work it caused. parent_turn_id links the
-- branch: the history the model sees is the chain from a turn to the root.
CREATE TABLE turns (
    id              TEXT PRIMARY KEY,
    task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    parent_turn_id  TEXT REFERENCES turns(id) ON DELETE SET NULL,
    kind            TEXT NOT NULL DEFAULT 'direction',  -- direction | resume | watch
    direction       TEXT NOT NULL,
    status          TEXT NOT NULL,   -- queued | running | completed | failed | cancelled | interrupted
    error           TEXT,
    usage_json      TEXT,
    resumed_from    TEXT,
    created_at      TEXT NOT NULL,
    started_at      TEXT,
    finished_at     TEXT
);
CREATE INDEX idx_turns_task ON turns (task_id, created_at);
CREATE INDEX idx_turns_status ON turns (status);

-- The one stream. seq is global and monotonic: every follower resumes by it.
CREATE TABLE items (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    id          TEXT NOT NULL UNIQUE,
    task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    turn_id     TEXT REFERENCES turns(id) ON DELETE CASCADE,
    type        TEXT NOT NULL,
    payload     TEXT NOT NULL,
    created_at  TEXT NOT NULL
);
CREATE INDEX idx_items_task ON items (task_id, seq);
CREATE INDEX idx_items_turn ON items (turn_id, seq);

-- Durable outputs a task produced: reports, survey snapshots, analyses, files.
CREATE TABLE artifacts (
    id          TEXT PRIMARY KEY,
    task_id     TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    turn_id     TEXT REFERENCES turns(id) ON DELETE SET NULL,
    kind        TEXT NOT NULL,
    title       TEXT NOT NULL,
    provider_id TEXT,
    payload     TEXT,
    path        TEXT,
    created_at  TEXT NOT NULL
);
CREATE INDEX idx_artifacts_task ON artifacts (task_id, created_at);
CREATE INDEX idx_artifacts_kind ON artifacts (kind, provider_id, created_at);

-- Files the user attached (inventory CSV, access logs) and evidence the
-- import tool fetched. Rows land in DuckDB under the data dir; this is the index.
CREATE TABLE datasets (
    id               TEXT PRIMARY KEY,
    task_id          TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    origin           TEXT NOT NULL,          -- upload | import
    dataset_type     TEXT NOT NULL,          -- access_log | inventory | unknown
    filename         TEXT NOT NULL,
    path             TEXT NOT NULL,
    size_bytes       INTEGER NOT NULL DEFAULT 0,
    row_count        INTEGER,
    status           TEXT NOT NULL,          -- ready | analyzed | failed
    detail           TEXT,
    provider_id      TEXT,
    bucket           TEXT,
    created_at       TEXT NOT NULL
);
CREATE INDEX idx_datasets_task ON datasets (task_id, created_at);

-- The storage estate.
CREATE TABLE estate_buckets (
    provider_id      TEXT NOT NULL REFERENCES cloud_providers(id) ON DELETE CASCADE,
    bucket           TEXT NOT NULL,
    region           TEXT,
    posture          TEXT,
    last_checked_at  TEXT NOT NULL,
    source_task_id   TEXT,
    PRIMARY KEY (provider_id, bucket)
);

CREATE TABLE issues (
    id                  TEXT PRIMARY KEY,
    provider_id         TEXT NOT NULL REFERENCES cloud_providers(id) ON DELETE CASCADE,
    bucket              TEXT NOT NULL,
    code                TEXT NOT NULL,
    fingerprint         TEXT NOT NULL UNIQUE,
    severity            TEXT NOT NULL,
    status              TEXT NOT NULL,   -- open | fix_proposed | resolved | recurred | accepted
    detail              TEXT,
    first_seen_at       TEXT NOT NULL,
    last_seen_at        TEXT NOT NULL,
    resolved_at         TEXT,
    resolved_by         TEXT,
    source_task_id      TEXT,
    fix                 TEXT,
    last_verified_at    TEXT,
    last_verify_result  TEXT,
    updated_at          TEXT NOT NULL
);
CREATE INDEX idx_issues_status ON issues (status, severity);

CREATE TABLE issue_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id   TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    source     TEXT,
    detail     TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_issue_events_issue ON issue_events (issue_id, id);

CREATE TABLE watch_schedules (
    provider_id     TEXT PRIMARY KEY REFERENCES cloud_providers(id) ON DELETE CASCADE,
    enabled         INTEGER NOT NULL DEFAULT 0,
    interval_hours  INTEGER NOT NULL DEFAULT 24,
    next_run_at     TEXT,
    last_run_at     TEXT,
    last_status     TEXT,
    last_summary    TEXT,
    last_task_id    TEXT,
    updated_at      TEXT NOT NULL
);

-- Append-only audit of every tool call and every setting change. Sanitized.
CREATE TABLE audit (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    at          TEXT NOT NULL,
    actor       TEXT NOT NULL,     -- agent | user | watch | system
    action      TEXT NOT NULL,
    task_id     TEXT,
    target      TEXT,
    ok          INTEGER NOT NULL DEFAULT 1,
    duration_ms INTEGER,
    detail      TEXT
);
CREATE INDEX idx_audit_at ON audit (at);
CREATE INDEX idx_audit_task ON audit (task_id, id);

-- Local trace spans from the Agents SDK trace processor: names, timings and
-- sizes only — never prompts, arguments or outputs.
CREATE TABLE spans (
    id          TEXT PRIMARY KEY,
    trace_id    TEXT NOT NULL,
    parent_id   TEXT,
    task_id     TEXT,
    turn_id     TEXT,
    kind        TEXT NOT NULL,
    name        TEXT NOT NULL,
    started_at  TEXT,
    ended_at    TEXT,
    error       TEXT,
    attributes  TEXT
);
CREATE INDEX idx_spans_trace ON spans (trace_id);
CREATE INDEX idx_spans_turn ON spans (turn_id);
"""

# v6: notes the user and the Agent keep about the estate (visible, editable), and
# a bounded posture history per bucket so a bucket page can show how it changed.
_V2 = """
CREATE TABLE notes (
    id           TEXT PRIMARY KEY,
    provider_id  TEXT REFERENCES cloud_providers(id) ON DELETE CASCADE,
    bucket       TEXT,
    text         TEXT NOT NULL,
    source       TEXT NOT NULL,   -- user | agent | accept
    task_id      TEXT,
    issue_id     TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);
CREATE INDEX idx_notes_scope ON notes (provider_id, bucket, updated_at);

CREATE TABLE posture_history (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_id  TEXT NOT NULL REFERENCES cloud_providers(id) ON DELETE CASCADE,
    bucket       TEXT NOT NULL,
    posture      TEXT NOT NULL,
    source       TEXT NOT NULL,
    task_id      TEXT,
    observed_at  TEXT NOT NULL
);
CREATE INDEX idx_posture_history_bucket ON posture_history (provider_id, bucket, id);
-- What was known before v6 is the first observation, dated when it was last checked.
INSERT INTO posture_history (provider_id, bucket, posture, source, task_id, observed_at)
    SELECT provider_id, bucket, posture, 'import', source_task_id, last_checked_at
    FROM estate_buckets WHERE posture IS NOT NULL;
CREATE INDEX idx_issues_bucket ON issues (provider_id, bucket);
"""

MIGRATIONS: list[tuple[int, str, str]] = [
    (1, "v5_items_estate", _V1),
    (2, "v6_notes_posture_history", _V2),
]

HEAD = MIGRATIONS[-1][0]


def apply_migrations(conn: sqlite3.Connection) -> int:
    """Apply pending migrations, each in its own transaction. Returns the count."""
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations ("
        " version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)")
    applied = {r[0] for r in conn.execute("SELECT version FROM schema_migrations").fetchall()}
    count = 0
    for version, name, sql in MIGRATIONS:
        if version in applied:
            continue
        safe_name = re.sub(r"[^a-z0-9_]", "", name)
        # executescript commits anything pending, then runs the whole script;
        # the explicit transaction makes the migration all-or-nothing.
        try:
            conn.executescript(
                "BEGIN;\n" + sql + "\nINSERT INTO schema_migrations (version, name, applied_at) "
                f"VALUES ({int(version)}, '{safe_name}', strftime('%Y-%m-%dT%H:%M:%SZ','now'));\nCOMMIT;")
        except Exception:
            try:
                conn.execute("ROLLBACK")
            except Exception:  # noqa: BLE001 — nothing open
                pass
            raise
        count += 1
    return count
