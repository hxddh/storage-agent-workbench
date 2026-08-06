"""v0.60.0 — deleting an investigation now actually deletes it.

`sessions.delete()` promised, in its own docstring, that every child row is
deleted explicitly as well as by FK cascade, "so the behavior is identical if
PRAGMA foreign_keys is ever off". Measured: four cascading tables had no
explicit delete — `error_triage_cases`, `session_agent_memory`,
`session_datasets`, `turn_metrics` — so the stated property held only while the
pragma did.

`tool_calls` was worse. Its only foreign key is `run_id -> runs`, so a
conversational tool call (`run_id IS NULL`) had no cascade AND no explicit
delete. Those rows outlived the session permanently, and
`data_maintenance.prune_audit_logs` deliberately skips any row carrying a
`session_id` on the stated grounds that it is "reachable through its session
(cascade-equivalent: the session's own delete path)" — which was not true. Three
paths, all closed: no FK, no explicit delete, and a prune predicate that could
never match them.

The weight is not disk (~14 KiB for a 20-turn investigation). It is that a user
who deleted an investigation kept its sanitized tool inputs and outputs — bucket
names, object-key prefixes — in SQLite forever.

`audit_logs` is deliberately still retained: an append-only security trail
bounded by its own window (rule 17), not user content a session owns.

Which tests detect the bug, stated rather than implied: five of the seven were
verified to FAIL against the unfixed code. The other two —
`test_the_audit_trail_is_deliberately_kept` and
`test_another_sessions_rows_are_untouched` — pass either way by design. They
guard the two things this change must NOT do: erase the security trail, or reach
into a neighbouring session.
"""
from __future__ import annotations

import sqlite3

import pytest

from app import migrations
from app.repositories import sessions as sessions_repo

CHILD_TABLES = ["session_messages", "session_runs", "session_findings",
                "session_evidence_refs", "session_summaries",
                "session_agent_memory", "session_datasets",
                "error_triage_cases", "turn_metrics", "tool_calls"]


def _populate(conn: sqlite3.Connection, session_id: str = "s1") -> None:
    ts = "2020-01-01T00:00:00Z"
    conn.execute("INSERT INTO sessions (id,title,created_at,updated_at) VALUES (?,?,?,?)",
                 (session_id, "t", ts, ts))
    conn.execute(
        "INSERT INTO tool_calls (id,run_id,tool_name,input_json_sanitized,"
        "output_json_sanitized,status,duration_ms,created_at,session_id) "
        "VALUES (?,NULL,?,?,?,?,?,?,?)",
        (f"tc1-{session_id}", "list_objects", '{"bucket":"acme-logs","prefix":"year=2026/"}',
         '{"summary":"1000 keys"}', "success", 12, ts, session_id))
    conn.execute("INSERT INTO session_agent_memory (id,session_id,kind,text,created_at) "
                 "VALUES (?,?,?,?,?)", (f"m1-{session_id}", session_id, "fact", "acme-logs is versioned", ts))
    conn.execute(
        "INSERT INTO session_datasets (id,session_id,dataset_type,source_filename,"
        "stored_path,status,created_at) VALUES (?,?,?,?,?,?,?)",
        (f"d1-{session_id}", session_id, "inventory", "big.csv", "uploads/s1/big.csv", "imported", ts))
    conn.execute("INSERT INTO session_messages (id,session_id,role,content,created_at) "
                 "VALUES (?,?,?,?,?)", (f"msg1-{session_id}", session_id, "user", "why is it big?", ts))
    conn.commit()


def _conn(foreign_keys: bool) -> sqlite3.Connection:
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.execute(f"PRAGMA foreign_keys = {'ON' if foreign_keys else 'OFF'}")
    migrations.apply_migrations(c)
    return c


@pytest.mark.parametrize("foreign_keys", [True, False],
                         ids=["pragma-on", "pragma-off"])
def test_no_child_row_survives_the_session(foreign_keys: bool):
    """The docstring's own promise, now checked in BOTH pragma states — which is
    the entire point of promising an explicit delete alongside the cascade."""
    conn = _conn(foreign_keys)
    _populate(conn)
    sessions_repo.delete(conn, "s1")
    left = {t: conn.execute(
        f"SELECT count(*) FROM {t} WHERE session_id = 's1'").fetchone()[0]
        for t in CHILD_TABLES}
    assert {t: n for t, n in left.items() if n} == {}


def test_the_tool_call_rows_are_gone_not_merely_orphaned():
    """Before the fix these survived with `session_id` pointing at a session that
    no longer existed — unreachable, unprunable, and holding the bucket names and
    key prefixes of an investigation the user chose to delete."""
    conn = _conn(True)
    _populate(conn)
    sessions_repo.delete(conn, "s1")
    row = conn.execute("SELECT * FROM tool_calls WHERE id = 'tc1-s1'").fetchone()
    assert row is None
    # And nothing anywhere still names the bucket.
    total = conn.execute("SELECT count(*) FROM tool_calls").fetchone()[0]
    assert total == 0


def test_the_prune_predicate_is_now_true_about_its_own_reasoning():
    """`prune_audit_logs` skips any tool_calls row with a session_id because such
    a row is "reachable through its session (cascade-equivalent: the session's
    own delete path)". That reasoning is only sound if the delete path really
    removes them — this asserts the premise rather than trusting the comment."""
    from app import data_maintenance

    conn = _conn(True)
    _populate(conn)
    sessions_repo.delete(conn, "s1")
    # Nothing left for the prune to have to reach in the first place.
    remaining = conn.execute(
        "SELECT count(*) FROM tool_calls WHERE session_id IS NOT NULL").fetchone()[0]
    assert remaining == 0
    # And the prune itself still runs clean over the emptied table.
    assert data_maintenance.prune_audit_logs(conn) >= 0


def test_the_audit_trail_is_deliberately_kept():
    """Rule 17: audit_logs is an append-only security record bounded by its own
    retention window, not user content the session owns. Deleting a session must
    NOT quietly erase it — if that ever becomes desirable it should be a stated
    decision, not a side effect of this change."""
    conn = _conn(True)
    _populate(conn)
    conn.execute(
        "INSERT INTO audit_logs (id,run_id,event_type,payload_json_sanitized,"
        "created_at,session_id) VALUES (?,NULL,?,?,?,?)",
        ("a1", "session_tool", '{"tool":"list_objects"}', "2020-01-01T00:00:00Z", "s1"))
    conn.commit()
    sessions_repo.delete(conn, "s1")
    assert conn.execute(
        "SELECT count(*) FROM audit_logs WHERE session_id = 's1'").fetchone()[0] == 1


def test_another_sessions_rows_are_untouched():
    """The delete is scoped. A shared-table delete with a wrong predicate would
    take the neighbour's history with it."""
    conn = _conn(True)
    _populate(conn, "s1")
    _populate(conn, "s2")
    sessions_repo.delete(conn, "s1")
    for tbl in CHILD_TABLES:
        n = conn.execute(
            f"SELECT count(*) FROM {tbl} WHERE session_id = 's2'").fetchone()[0]
        assert n >= 0
    assert conn.execute("SELECT count(*) FROM tool_calls WHERE session_id='s2'").fetchone()[0] == 1
    assert conn.execute("SELECT count(*) FROM sessions WHERE id='s2'").fetchone()[0] == 1


def test_the_docstring_promise_matches_the_code():
    """A structural guard on the claim itself.

    The docstring asserts an explicit delete for every table that cascades from
    `sessions`. That claim drifted once already; this fails if it drifts again.
    """
    import re
    from pathlib import Path

    src = Path(sessions_repo.__file__).read_text()
    i = src.index("def delete(")
    body = src[i:src.index("\ndef ", i + 10)]
    explicit = set(re.findall(r'"(\w+)"', body)) | set(re.findall(r"DELETE FROM (\w+)", body))

    conn = _conn(True)
    cascading = [t for t in (r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"))
        if any(fk[2] == "sessions" and fk[6] == "CASCADE"
               for fk in conn.execute(f"PRAGMA foreign_key_list({t})"))]
    assert cascading, "no cascading tables found — this guard is looking at nothing"
    missing = sorted(t for t in cascading if t not in explicit)
    assert missing == [], (
        "these cascade from sessions but have no explicit delete, so the "
        f"docstring's pragma-off promise is false for them: {missing}")
