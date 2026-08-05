"""v0.48.0 — the report documents the investigation that actually happened.

The report predates the v0.20 shift to an agent-first product. It drew only
from LINKED runs, and the agent's own work is deliberately never linked as a run
card — so a real six-turn investigation (probe the bucket, hit a 403, explain
the cause) rendered as a page of em dashes. The one document meant to leave the
app documented none of the work.

These tests pin the fix and its bounds: the record is complete enough to be
useful, bounded enough to be readable, honest when it truncates, and still
carries none of the things a report must never contain.
"""

from __future__ import annotations

import sqlite3

import pytest

from app.migrations import apply_migrations
from app.repositories import session_activity
from app.repositories import sessions as repo
from app.sessions import session_report


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    apply_migrations(conn)
    conn.execute(
        "INSERT INTO sessions (id, title, goal, status, created_at, updated_at) "
        "VALUES ('s1', 'Why is upload failing', 'find the cause', 'active', 'x', 'x')"
    )
    return conn


def _turn(conn, i: int, *, answer: str | None = None, tools=None, grounding=None) -> str:
    repo.add_message(conn, "s1", "user", f"question {i}")
    return repo.add_message(
        conn, "s1", "assistant", answer if answer is not None else f"answer {i}",
        tool_activity=tools if tools is not None else [
            {"tool": "head_bucket", "target": "b", "result": "200"},
        ],
        grounding=grounding if grounding is not None else {
            "evidence_used": [f"head_bucket returned 200 ({i})"],
            "evidence_gaps": ["IAM identity policy not readable"],
            "skills_used": ["s3-diagnostics"],
        },
        proposed_actions=[],
    )


def _render(conn) -> str:
    ov = session_activity.overview(conn, "s1")
    return session_report.render_session_report(
        dict(conn.execute("SELECT * FROM sessions WHERE id='s1'").fetchone()),
        repo.get_summary(conn, "s1") or {}, repo.list_runs(conn, "s1"), [], [],
        messages=repo.list_messages(conn, "s1"),
        activity=session_activity.list_activity(conn, "s1")["items"],
        usage=ov["usage"], turn_metrics=ov["turns"],
        audit_events=session_activity.list_audit(conn, "s1")["items"],
    )


# --- the hole this closes ----------------------------------------------------

def test_a_conversational_investigation_is_no_longer_an_empty_report():
    conn = _db()
    for i in range(3):
        _turn(conn, i)
    conn.commit()

    md = _render(conn)
    # The questions, the answers, and the grounding all reach the artifact.
    assert "question 1" in md and "answer 1" in md
    assert "head_bucket returned 200" in md
    assert "IAM identity policy not readable" in md
    # And the summary counts the work that happened, not just linked runs.
    assert "3 conversational turn(s)" in md


def test_the_tool_breakdown_reports_failures():
    conn = _db()
    mid = _turn(conn, 0)
    for i, (tool, status) in enumerate(
        [("head_bucket", "success"), ("list_objects", "error"), ("list_objects", "success")]
    ):
        conn.execute(
            "INSERT INTO tool_calls (id, run_id, session_id, tool_name, input_json_sanitized, "
            " output_json_sanitized, status, duration_ms, created_at) "
            "VALUES (?, NULL, 's1', ?, '{}', '{}', ?, 120, ?)",
            (f"c{i}", tool, status, f"2026-01-01T00:00:0{i}Z"),
        )
    session_activity.record_turn(conn, "s1", turn_id="t", message_id=mid, model="m",
                                 duration_ms=4200, tool_calls=3, usage=None)
    conn.commit()

    md = _render(conn)
    assert "`list_objects`" in md and "`head_bucket`" in md
    # A failure the reader would want to know about must not be aggregated away.
    assert "| `list_objects` | 2 | 1 |" in md


def test_cost_never_invents_tokens():
    conn = _db()
    mid = _turn(conn, 0)
    session_activity.record_turn(conn, "s1", turn_id="t", message_id=mid, model="m",
                                 duration_ms=4200, tool_calls=1, usage=None)
    conn.commit()

    md = _render(conn)
    # Wall-clock is always measurable; tokens are only ever what the provider said.
    assert "4.2 s" in md
    assert "not reported by the model provider" in md


def test_cost_reports_measured_tokens_when_the_provider_gave_them():
    conn = _db()
    mid = _turn(conn, 0)
    session_activity.record_turn(conn, "s1", turn_id="t", message_id=mid, model="m",
                                 duration_ms=1000, tool_calls=0,
                                 usage={"requests": 1, "input_tokens": 900,
                                        "output_tokens": 120, "total_tokens": 1020})
    conn.commit()
    md = _render(conn)
    assert "900 in / 120 out" in md


# --- bounded, and honest about it --------------------------------------------

def test_a_very_long_investigation_is_trimmed_and_says_so():
    conn = _db()
    for i in range(session_report.MAX_TURNS + 15):
        _turn(conn, i)
    conn.commit()

    md = _render(conn)
    assert f"Showing the most recent {session_report.MAX_TURNS} of" in md
    # The newest turns are the ones kept — a report that dropped the conclusion
    # to keep the opening would be the wrong half.
    assert f"question {session_report.MAX_TURNS + 14}" in md
    assert "question 0" not in md


def test_a_long_answer_is_excerpted_with_the_cut_marked():
    conn = _db()
    _turn(conn, 0, answer="A" * 3000)
    conn.commit()
    md = _render(conn)
    assert "_(trimmed)_" in md
    assert "A" * 3000 not in md


def test_an_unanswered_question_is_not_reported_as_a_turn():
    conn = _db()
    _turn(conn, 0)
    repo.add_message(conn, "s1", "user", "a question still in flight")
    conn.commit()
    md = _render(conn)
    # A turn is a completed exchange. Reporting a dangling question as one would
    # imply an answer that does not exist.
    assert "a question still in flight" not in md


# --- what a report must never contain ----------------------------------------

def test_the_report_still_redacts():
    conn = _db()
    _turn(conn, 0, answer="the key is AKIAIOSFODNN7EXAMPLE and it failed")
    conn.commit()
    md = _render(conn)
    assert "AKIAIOSFODNN7EXAMPLE" not in md


def test_the_empty_session_renders_without_pretending():
    conn = _db()
    conn.commit()
    md = _render(conn)
    assert "No conversational turns recorded" in md
    assert "No tool calls recorded" in md
    # Rendering must not raise on a session that has done nothing yet.
    assert md.startswith("# Session Report:")


@pytest.mark.parametrize("section", [
    "## Investigation", "## Tools run", "## Cost", "## Audit trail", "## Safety",
])
def test_every_new_section_is_present(section):
    conn = _db()
    _turn(conn, 0)
    conn.commit()
    assert section in _render(conn)


def test_the_old_positional_signature_still_renders():
    """An older caller must degrade to the historical document, not raise."""
    conn = _db()
    _turn(conn, 0)
    conn.commit()
    md = session_report.render_session_report(
        dict(conn.execute("SELECT * FROM sessions WHERE id='s1'").fetchone()),
        repo.get_summary(conn, "s1") or {}, repo.list_runs(conn, "s1"), [], [])
    assert md.startswith("# Session Report:")
    assert "No conversational turns recorded" in md
