"""v0.95 — typed Storage Task Context is the prompt's stable grounding.

The latest context version is injected into the stable half (with skill catalog
/ providers) so a restart's first turn is grounded identically to the turn
before the restart. Thread replay does not re-derive buckets/datasets/decisions.
"""

from __future__ import annotations

import json
import sqlite3

from app.agent_runtime import session_agent
from app.migrations import apply_migrations
from app.task_runtime import context as task_context
from app.task_runtime import store


def _fresh_db(path) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    apply_migrations(conn)
    return conn


def _seed_task(conn, task_id="task-ctx"):
    conn.execute(
        "INSERT INTO sessions (id, title, goal, primary_bucket, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (task_id, "Diagnose acme-logs", "why 403", "acme-logs",
         "2026-08-01T00:00:00Z", "2026-08-01T00:00:00Z"),
    )
    store.ensure_task(conn, task_id, "Diagnose acme-logs", "why 403")
    conn.execute(
        "INSERT INTO session_datasets (id, session_id, dataset_type, status, "
        "detected_format, row_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ("ds1", task_id, "access_log", "ready", "s3_access_log", 1200,
         "2026-08-01T00:00:00Z"),
    )
    conn.execute(
        "INSERT INTO tool_calls (id, run_id, session_id, tool_name, "
        "input_json_sanitized, output_json_sanitized, status, created_at) "
        "VALUES (?, NULL, ?, 'head_bucket', ?, '{}', 'success', ?)",
        ("c1", task_id, json.dumps({"bucket": "acme-logs"}), "2026-08-01T00:00:00Z"),
    )
    conn.commit()
    return task_id


def _stable_from_prompt(prompt: str) -> str:
    marker = "configured_providers:\n"
    idx = prompt.find(marker)
    assert idx >= 0
    rest = prompt[idx:]
    for cut in ("\n\nUser question:", "\n\nattached_files"):
        at = rest.find(cut)
        if at > 0:
            rest = rest[:at]
            break
    return rest


def test_typed_context_is_in_stable_half_and_survives_restart(tmp_path):
    conn = _fresh_db(tmp_path / "ctx.db")
    task_id = _seed_task(conn)
    version = task_context.refresh(conn, task_id)
    conn.commit()
    assert version == 1
    session = dict(conn.execute("SELECT * FROM sessions WHERE id=?", (task_id,)).fetchone())
    session["id"] = task_id

    prompt1, _, ctx1 = session_agent._build_prompt(
        session, {}, [], "why does acme-logs return 403?", conn)
    assert "storage_task_context" in ctx1
    typed = ctx1["storage_task_context"]
    assert "acme-logs" in typed["buckets_in_focus"]
    assert typed["attached_datasets"][0]["id"] == "ds1"
    assert typed["open_decisions"] == []
    assert "Authoritative machine state" in typed["note"]
    stable, volatile = session_agent.split_context_for_cache(ctx1)
    assert "storage_task_context" in stable
    assert "storage_task_context" not in volatile
    assert "recent_messages" in volatile

    conn.close()
    conn2 = sqlite3.connect(tmp_path / "ctx.db")
    conn2.row_factory = sqlite3.Row
    session2 = dict(conn2.execute("SELECT * FROM sessions WHERE id=?", (task_id,)).fetchone())
    session2["id"] = task_id
    prompt2, _, ctx2 = session_agent._build_prompt(
        session2, {}, [], "why does acme-logs return 403?", conn2)
    assert ctx2["storage_task_context"] == ctx1["storage_task_context"]
    assert _stable_from_prompt(prompt1) == _stable_from_prompt(prompt2)
    conn2.close()


def test_open_decisions_come_from_typed_context_not_replay(tmp_path):
    conn = _fresh_db(tmp_path / "dec.db")
    task_id = _seed_task(conn)
    store.open_approval(
        conn, task_id, None, "import_access_log", "Import logs", "Need the files",
        {"tool": "import_evidence", "prefill": {"bucket": "acme-logs",
                                                "source_type": "access_log"}})
    conn.commit()
    task_context.refresh(conn, task_id)
    conn.commit()
    session = dict(conn.execute("SELECT * FROM sessions WHERE id=?", (task_id,)).fetchone())
    session["id"] = task_id
    _, _, ctx = session_agent._build_prompt(session, {}, [], "continue", conn)
    assert ctx["storage_task_context"]["open_decisions"]
    assert ctx["storage_task_context"]["primary_bucket"] == "acme-logs"
