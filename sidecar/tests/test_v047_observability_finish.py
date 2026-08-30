"""v0.47.0 — finishing what v0.45.0 started, and bounding the thread.

Two of these pin a REGRESSION v0.45.0 introduced and this release fixes:

  * the retention sweep deleted a live session's tool calls, because v0.45.0
    made the conversational agent write rows with ``run_id IS NULL`` — exactly
    the shape the sweep treated as "belongs to nobody";
  * most session-scoped audit events never set ``session_id``, so the
    inspector's audit timeline showed a fraction of what happened while looking
    complete.

The rest bound the thread: a long investigation must stay in one session without
its history being re-sent in full on every open and every turn.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone

import pytest

from app import audit, data_maintenance
from app.migrations import apply_migrations
from app.repositories import session_activity
from app.repositories import sessions as repo


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    apply_migrations(conn)
    conn.execute(
        "INSERT INTO sessions (id, title, status, created_at, updated_at) "
        "VALUES ('s1', 't', 'active', 'x', 'x')"
    )
    return conn


def _aged(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")


def _tool_call(conn, cid: str, *, session_id: str | None, run_id: str | None, created_at: str):
    conn.execute(
        "INSERT INTO tool_calls (id, run_id, session_id, tool_name, input_json_sanitized, "
        " output_json_sanitized, status, duration_ms, created_at) "
        "VALUES (?, ?, ?, 'list_objects', '{}', '{}', 'success', 5, ?)",
        (cid, run_id, session_id, created_at),
    )


# --- the retention regression -------------------------------------------------

def test_retention_never_touches_a_live_sessions_tool_calls(monkeypatch):
    """v0.45.0 regression: the sweep matched ``run_id IS NULL`` alone, which from
    that release also described every conversational tool call."""
    monkeypatch.setenv("STORAGE_AGENT_AUDIT_RETENTION_DAYS", "180")
    conn = _db()
    _tool_call(conn, "owned", session_id="s1", run_id=None, created_at=_aged(400))
    conn.commit()

    data_maintenance.prune_audit_logs(conn)

    # Rule 17's evidence for a session that still exists must survive.
    assert session_activity.overview(conn, "s1")["tool_calls"] == 1


def test_retention_still_sweeps_genuinely_ownerless_rows(monkeypatch):
    monkeypatch.setenv("STORAGE_AGENT_AUDIT_RETENTION_DAYS", "180")
    conn = _db()
    _tool_call(conn, "orphan", session_id=None, run_id=None, created_at=_aged(400))
    _tool_call(conn, "recent", session_id=None, run_id=None, created_at=_aged(1))
    conn.commit()

    data_maintenance.prune_audit_logs(conn)

    rows = {r["id"] for r in conn.execute("SELECT id FROM tool_calls")}
    # Unreachable AND old → swept. Unreachable but recent → kept.
    assert rows == {"recent"}


def test_a_zero_window_disables_the_sweep_entirely(monkeypatch):
    monkeypatch.setenv("STORAGE_AGENT_AUDIT_RETENTION_DAYS", "0")
    conn = _db()
    _tool_call(conn, "orphan", session_id=None, run_id=None, created_at=_aged(9999))
    audit.record(conn, "old", {}, run_id=None)
    conn.execute("UPDATE audit_logs SET created_at = ?", (_aged(9999),))
    conn.commit()

    assert data_maintenance.prune_audit_logs(conn) == 0
    assert conn.execute("SELECT count(*) FROM tool_calls").fetchone()[0] == 1


# --- the audit trail is session-scoped throughout -----------------------------

# Widened in v0.48.0: the check used to name four agent-tool modules, so a new
# `audit.record` written anywhere else could still omit `session_id`. It now
# sweeps the whole app and decides per call site.
_SESSION_SCOPED_EXEMPT = {
    # The session is ceasing to exist; a session-scoped row could only ever be
    # read back through a session that is gone. The id stays in the payload.
    "session.delete",
    # The run row (and its session link) is already deleted by the time this is
    # recorded, so there is no session to attribute it to. Run-scoped is honest;
    # guessing would not be.
    "run.delete",
    # Evidence imports are import-scoped: plan/confirm/run are addressed by
    # import_id and may exist without any session (a run started outside one).
    # The module only mentions "session_id" since v0.94 because the completed
    # import is ALSO indexed as a task artifact when its account run belongs to
    # a task; the import lifecycle audit rows themselves stay import-scoped.
    "evidence_import.plan", "evidence_import.confirm",
    "evidence_import.download", "evidence_import.failed",
}


def _audit_calls(root):
    """Every ``audit.record(...)`` in the app, as (path, lineno, event, kwargs)."""
    import ast

    for path in sorted((root / "app").rglob("*.py")):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            fn = node.func
            if not (isinstance(fn, ast.Attribute) and fn.attr == "record"
                    and isinstance(fn.value, ast.Name) and fn.value.id == "audit"):
                continue
            event = None
            if len(node.args) >= 2 and isinstance(node.args[1], ast.Constant):
                event = node.args[1].value
            yield (path.relative_to(root), node.lineno, event,
                   {kw.arg for kw in node.keywords})


def test_every_session_scoped_audit_call_sets_session_id():
    """A rule-17 row the inspector cannot retrieve is a row that was written and
    then orphaned — the exact gap v0.45.0 set out to close and v0.47.0 finished.

    A call site counts as session-scoped when it can see a session at all: it
    either passes ``session_id=`` or is in a module that never handles one.
    """
    import pathlib

    root = pathlib.Path(__file__).resolve().parents[1]
    offenders: list[str] = []
    for rel, lineno, event, kwargs in _audit_calls(root):
        if "session_id" in kwargs:
            continue
        if event in _SESSION_SCOPED_EXEMPT:
            continue
        # Only flag modules that DO deal with sessions — a run executor's audit
        # rows legitimately belong to their run, not to a session.
        src = (root / rel).read_text()
        if "session_id" not in src:
            continue
        offenders.append(f"{rel}:{lineno} ({event})")
    assert offenders == []


def test_the_sweep_actually_finds_call_sites():
    """Guard the guard: a broken matcher that finds nothing would pass silently."""
    import pathlib

    root = pathlib.Path(__file__).resolve().parents[1]
    calls = list(_audit_calls(root))
    assert len(calls) > 20
    assert any("session_id" in kwargs for *_rest, kwargs in calls)


def test_an_agent_file_analysis_lands_in_the_sessions_audit_trail():
    conn = _db()
    audit.record(conn, "session.analyze_uploaded_file", {"dataset_id": "d1"},
                 run_id=None, session_id="s1")
    audit.record(conn, "next_action_prepared", {"action_type": "run_diagnostic"},
                 run_id=None, session_id="s1")
    conn.commit()
    kinds = {i["event_type"] for i in session_activity.list_audit(conn, "s1")["items"]}
    assert kinds == {"session.analyze_uploaded_file", "next_action_prepared"}


# --- thread paging ------------------------------------------------------------

def test_a_thread_opens_to_its_tail_not_its_whole_history():
    conn = _db()
    for i in range(150):
        repo.add_message(conn, "s1", "user", f"m{i}")
    conn.commit()

    page = repo.list_messages(conn, "s1", limit=repo.DEFAULT_MESSAGE_PAGE)
    assert len(page) == repo.DEFAULT_MESSAGE_PAGE
    # Chronological within the page, and it is the NEWEST end of the thread.
    assert page[-1]["content"] == "m149"
    assert page[0]["content"] == f"m{150 - repo.DEFAULT_MESSAGE_PAGE}"
    assert repo.count_messages(conn, "s1") == 150


def test_paging_walks_backwards_without_gaps_or_repeats():
    conn = _db()
    for i in range(25):
        repo.add_message(conn, "s1", "user", f"m{i}")
    conn.commit()

    seen: list[str] = []
    cursor = None
    for _ in range(10):
        page = repo.list_messages(conn, "s1", limit=10, before_rowid=cursor)
        if not page:
            break
        seen = [m["content"] for m in page] + seen
        cursor = page[0]["seq"]
    # Every message exactly once, in order — a cursor that failed to advance
    # would repeat a page forever, which is how this was first written.
    assert seen == [f"m{i}" for i in range(25)]


def test_the_unbounded_form_survives_for_the_report_builder():
    conn = _db()
    for i in range(80):
        repo.add_message(conn, "s1", "user", f"m{i}")
    conn.commit()
    # The report summarises the WHOLE investigation; paging it would silently
    # narrow what the report is about.
    assert len(repo.list_messages(conn, "s1")) == 80


def test_the_page_size_is_clamped():
    conn = _db()
    for i in range(5):
        repo.add_message(conn, "s1", "user", f"m{i}")
    conn.commit()
    assert len(repo.list_messages(conn, "s1", limit=10_000)) == 5
    assert len(repo.list_messages(conn, "s1", limit=0)) == 1  # never a zero-row page


@pytest.mark.parametrize("path", ["", "/messages"])
def test_the_api_reports_the_total_so_a_partial_thread_never_looks_complete(client, path):
    sid = client.post("/sessions", json={"title": "long"}).json()["id"]
    body = client.get(f"/sessions/{sid}{path}").json()
    # Whether or not there is more, the client is told how much exists.
    assert "message_total" in body or "total" in body
