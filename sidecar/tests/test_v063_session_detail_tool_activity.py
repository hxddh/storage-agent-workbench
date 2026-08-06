"""v0.63.0 — a session that ran a tool could not be opened at all.

`SessionMessageOut.tool_activity` was declared `list[dict[str, str]]` in PR #95,
when a trace row really was four strings. PR #141 then started recording what a
call actually did — `duration_ms` (int), `ok` (bool), `args` (dict) — and
nothing reconciled the two. Pydantic v2 does not coerce int/bool/dict into
`str`, so the response model raised a ValidationError and
`GET /sessions/{id}` answered **500** for any session containing a completed
tool call. That is every real investigation.

What the user sees is not a 500: the thread renders "Couldn't load this
session", the rail still lists the session by title, and the browser reports the
failure as `TypeError: Failed to fetch` because CORS headers are not attached to
an unhandled-exception response. So the conversation, its answers, and every
per-turn affordance below them (the turn footer, copy / edit / branch) are all
simply absent — while the paged `GET /sessions/{id}/messages` endpoint, which
returns a plain dict and is therefore unvalidated, had the same rows and served
them fine.

The tests build the trace row from the exact literal `session_tools.note()`
writes, so the schema is pinned to the producer rather than to a hand-written
guess at its shape.
"""
from __future__ import annotations

import json

import pytest

# The row `note()` appends to `activity`, field for field (session_tools.py).
REAL_ROW = {
    "id": "8a9f2c1b4d6e0f11",
    "tool": "head_bucket",
    "target": "acme-logs",
    "result": "200",
    "args": {"bucket": "acme-logs", "max_keys": 100, "recursive": False},
    "ok": True,
    "duration_ms": 42,
    "status": "completed",
}


def _session_with_activity(client, activity):
    sid = client.post("/sessions", json={"title": "investigation"}).json()["id"]
    from app import db
    from app.repositories import sessions as repo

    with db.connect() as conn:
        repo.add_message(conn, sid, "user", "why does acme-logs return 403")
        repo.add_message(conn, sid, "assistant", "The bucket policy omits s3:ListBucket.",
                         tool_activity=activity)
        conn.commit()
    return sid


def test_a_session_that_ran_a_tool_can_be_opened(client):
    """The whole bug in one line: the detail endpoint must not 500."""
    sid = _session_with_activity(client, [REAL_ROW])
    res = client.get(f"/sessions/{sid}")
    assert res.status_code == 200, res.text


def test_the_trace_row_survives_the_round_trip(client):
    """Types are preserved, not stringified — the UI reads `duration_ms` as a
    number and `ok` as a boolean, and a string "42" would render as a raw value
    while `"False"` is truthy."""
    sid = _session_with_activity(client, [REAL_ROW])
    msgs = client.get(f"/sessions/{sid}").json()["messages"]
    row = msgs[-1]["tool_activity"][0]
    assert row["duration_ms"] == 42
    assert row["ok"] is True
    assert row["args"] == REAL_ROW["args"]
    assert row["tool"] == "head_bucket"


def test_an_unmeasured_call_keeps_its_null_duration(client):
    """`duration_ms` is None when no start marker matched. None is honest —
    coercing it to 0 would claim the call took no time."""
    sid = _session_with_activity(client, [{**REAL_ROW, "duration_ms": None}])
    row = client.get(f"/sessions/{sid}").json()["messages"][-1]["tool_activity"][0]
    assert row["duration_ms"] is None


def test_an_audit_gap_reaches_the_client(client):
    """`audit_error` is written only when the audit row could not be (rule 17).
    A schema that dropped unknown keys would erase exactly the field whose
    presence is the signal."""
    sid = _session_with_activity(client, [{**REAL_ROW, "audit_error": "disk full"}])
    row = client.get(f"/sessions/{sid}").json()["messages"][-1]["tool_activity"][0]
    assert row["audit_error"] == "disk full"


def test_pre_v055_history_without_the_new_fields_still_loads(client):
    """Sessions recorded before ok/duration_ms/args existed must keep opening."""
    old = {"tool": "list_objects", "target": "acme-logs", "result": "12 keys", "status": "completed"}
    sid = _session_with_activity(client, [old])
    res = client.get(f"/sessions/{sid}")
    assert res.status_code == 200, res.text
    assert res.json()["messages"][-1]["tool_activity"][0]["tool"] == "list_objects"


def test_the_paged_endpoint_and_the_detail_endpoint_agree(client):
    """`/messages` returns an unvalidated dict and so never had the bug. It is
    the control: both endpoints must show the same trace."""
    sid = _session_with_activity(client, [REAL_ROW])
    detail = client.get(f"/sessions/{sid}").json()["messages"][-1]["tool_activity"]
    paged = client.get(f"/sessions/{sid}/messages").json()["messages"][-1]["tool_activity"]
    assert detail == paged


@pytest.mark.parametrize("bad", ["not-json", "{", ""])
def test_corrupt_persisted_activity_does_not_take_the_session_down(client, bad):
    """A malformed column must degrade to an empty trace, not a dead session."""
    from app import db
    from app.repositories import sessions as repo

    sid = _session_with_activity(client, [REAL_ROW])
    with db.connect() as conn:
        conn.execute("UPDATE session_messages SET tool_activity = ? WHERE role = 'assistant'", (bad,))
        conn.commit()
    res = client.get(f"/sessions/{sid}")
    assert res.status_code == 200, res.text
    assert res.json()["messages"][-1]["tool_activity"] == []


def test_a_corrupt_summary_column_costs_its_own_field_only(client):
    """`get_summary` decoded five JSON columns the same unguarded way, and it is
    read by the same endpoint. One damaged column must not close the session."""
    from app import db
    from app.repositories import sessions as repo

    sid = _session_with_activity(client, [REAL_ROW])
    with db.connect() as conn:
        repo.upsert_summary(conn, sid, {"summary_md": "The policy omits s3:ListBucket.",
                                        "open_questions": ["which principal?"]})
        conn.execute("UPDATE session_summaries SET open_questions_json = 'not-json'")
        conn.commit()
    res = client.get(f"/sessions/{sid}")
    assert res.status_code == 200, res.text
    summary = res.json()["summary"]
    assert summary["open_questions"] == []
    # The undamaged fields are still there — this degrades, it does not blank.
    assert summary["summary_md"] == "The policy omits s3:ListBucket."


def test_a_triage_case_with_no_summary_can_still_be_read(client):
    """`error_triage_cases.summary` is nullable while `TriageCaseOut.summary` is
    `str`, so a NULL there was a 500 on a read-only endpoint."""
    from app import db

    sid = client.post("/sessions", json={"title": "s"}).json()["id"]
    with db.connect() as conn:
        conn.execute(
            "INSERT INTO error_triage_cases (id, session_id, input_kind, summary, status,"
            " created_at, updated_at) VALUES ('case-1', ?, 'error_body', NULL, 'parsed', ?, ?)",
            (sid, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"),
        )
        conn.commit()
    res = client.get("/error-triage/case-1")
    assert res.status_code == 200, res.text
    assert res.json()["summary"] == ""


def test_the_producer_still_emits_the_shape_this_schema_promises():
    """Pins the schema to the writer. If `note()` grows a field of a new type,
    this fails here rather than as a 500 in front of a user."""
    from app.models.schemas import SessionMessageOut

    m = SessionMessageOut(id="m1", role="assistant", content="x",
                          tool_activity=[REAL_ROW], created_at="2026-01-01T00:00:00Z")
    assert json.loads(m.model_dump_json())["tool_activity"][0]["duration_ms"] == 42
