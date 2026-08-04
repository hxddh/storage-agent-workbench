"""v0.45.0 — session observability.

Before this version the product recorded rule-17 evidence it could never read
back per session: ``tool_calls`` and ``audit_logs`` carried no ``session_id``,
so a conversational turn's work was written and then orphaned. And token spend
was never recorded at all.

These tests pin the two properties that matter:

  * the trail is now session-scoped, bounded, and honest about truncation;
  * usage is MEASURED or MISSING — never estimated, never a fabricated zero.
"""

from __future__ import annotations

import sqlite3

import pytest

from app import audit
from app.agent_runtime import session_agent as sa
from app.migrations import apply_migrations
from app.repositories import session_activity


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


# --- session-scoped trail ----------------------------------------------------

def test_audit_rows_carry_the_session_that_produced_them():
    conn = _db()
    audit.record(conn, "session.message", {"hello": "world"}, run_id=None, session_id="s1")
    audit.record(conn, "unrelated", {}, run_id=None)  # no session → not in the trail
    out = session_activity.list_audit(conn, "s1")
    assert out["total"] == 1
    assert out["items"][0]["event_type"] == "session.message"
    assert out["items"][0]["payload"] == {"hello": "world"}


def test_tool_calls_are_retrievable_for_their_session():
    conn = _db()
    for i in range(3):
        conn.execute(
            "INSERT INTO tool_calls (id, run_id, session_id, tool_name, "
            " input_json_sanitized, output_json_sanitized, status, duration_ms, created_at) "
            "VALUES (?, NULL, 's1', ?, '{}', '{}', 'success', ?, ?)",
            (f"c{i}", f"tool_{i}", 10 * i, f"2026-01-01T00:00:0{i}Z"),
        )
    out = session_activity.list_activity(conn, "s1")
    # Oldest first: the timeline reads top-to-bottom in execution order.
    assert [i["tool_name"] for i in out["items"]] == ["tool_0", "tool_1", "tool_2"]
    assert out["truncated"] is False


def test_listing_is_bounded_and_admits_it():
    conn = _db()
    for i in range(20):
        conn.execute(
            "INSERT INTO tool_calls (id, run_id, session_id, tool_name, "
            " input_json_sanitized, output_json_sanitized, status, duration_ms, created_at) "
            "VALUES (?, NULL, 's1', 'x', '{}', '{}', 'success', 1, ?)",
            (f"c{i}", f"2026-01-01T00:00:{i:02d}Z"),
        )
    out = session_activity.list_activity(conn, "s1", limit=5)
    assert len(out["items"]) == 5
    assert out["total"] == 20
    # A partial timeline that looked complete would be worse than none at all.
    assert out["truncated"] is True
    # And the caller can never raise the ceiling past the hard cap.
    assert session_activity.list_activity(conn, "s1", limit=10_000)["limit"] == \
        session_activity.MAX_LIMIT


def test_a_deleted_session_takes_its_metrics_with_it():
    conn = _db()
    session_activity.record_turn(conn, "s1", turn_id="t", message_id="m", model="x",
                                 duration_ms=1, tool_calls=0, usage=None)
    conn.execute("DELETE FROM sessions WHERE id = 's1'")
    assert conn.execute("SELECT count(*) FROM turn_metrics").fetchone()[0] == 0


# --- usage: measured or missing, never invented -------------------------------

def test_no_rows_means_unavailable_not_zero():
    conn = _db()
    roll = session_activity.usage_rollup(conn, "s1")
    assert roll["available"] is False
    assert roll["total_tokens"] == 0  # a number is present, but `available` gates it


def test_a_turn_without_provider_usage_stores_null_not_zero():
    conn = _db()
    session_activity.record_turn(conn, "s1", turn_id="t1", message_id="m1", model="m",
                                 duration_ms=900, tool_calls=2, usage=None)
    row = conn.execute("SELECT * FROM turn_metrics").fetchone()
    # NULL is the honest encoding: "the provider never told us", distinct from
    # a measured zero.
    assert row["total_tokens"] is None
    assert row["duration_ms"] == 900 and row["tool_calls"] == 2
    assert session_activity.usage_rollup(conn, "s1")["available"] is False


def test_mixed_reporting_is_flagged_partial():
    conn = _db()
    session_activity.record_turn(conn, "s1", turn_id="t1", message_id="m1", model="m",
                                 duration_ms=100, tool_calls=0,
                                 usage={"requests": 1, "input_tokens": 10,
                                        "output_tokens": 5, "total_tokens": 15})
    session_activity.record_turn(conn, "s1", turn_id="t2", message_id="m2", model="m",
                                 duration_ms=200, tool_calls=0, usage=None)
    roll = session_activity.usage_rollup(conn, "s1")
    assert roll["available"] is True
    assert roll["partial"] is True  # the sum is a floor, not a total
    assert (roll["turns"], roll["turns_measured"]) == (2, 1)
    assert roll["total_tokens"] == 15
    assert roll["duration_ms"] == 300  # wall-clock is always measurable


# --- the snapshot the agent hands over ---------------------------------------

class _Usage:
    def __init__(self, requests=0, input_tokens=0, output_tokens=0, total_tokens=0):
        self.requests = requests
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens
        self.total_tokens = total_tokens


class _Ctx:
    def __init__(self, usage):
        self.usage = usage


class _Result:
    def __init__(self, usage):
        self.context_wrapper = _Ctx(usage)


def test_snapshot_is_none_when_the_provider_reported_nothing():
    assert sa._usage_snapshot(_Result(None)) is None
    assert sa._usage_snapshot(object()) is None
    # A zeroed Usage object means "not reported", not "free".
    assert sa._usage_snapshot(_Result(_Usage())) is None


def test_snapshot_sums_the_finalize_pass_into_the_turn():
    result = _Result(_Usage(requests=3, input_tokens=100, output_tokens=40, total_tokens=140))
    sa._stash_extra_usage(result, _Result(_Usage(requests=1, input_tokens=20,
                                                 output_tokens=10, total_tokens=30)))
    snap = sa._usage_snapshot(result)
    # A turn that hit its step budget pays for BOTH model runs; reporting only
    # the first would understate real spend.
    assert snap == {"requests": 4, "input_tokens": 120,
                    "output_tokens": 50, "total_tokens": 170}


def test_stashing_never_raises_on_an_odd_result():
    r = _Result(_Usage(total_tokens=5))
    sa._stash_extra_usage(r, object())  # no context_wrapper at all
    assert sa._usage_snapshot(r)["total_tokens"] == 5


# --- the stream_options fallback ---------------------------------------------

@pytest.mark.parametrize("msg", [
    "Unsupported parameter: 'stream_options'",
    "unknown field stream_options",
    "invalid_request_error: include_usage is not allowed",
    "Extra inputs are not permitted: stream_options",
])
def test_a_parameter_refusal_is_recognised(msg):
    assert sa._is_stream_options_rejection(Exception(msg)) is True


@pytest.mark.parametrize("msg", [
    "Rate limit reached for requests",
    "400 Bad Request",
    "An assistant message with 'tool_calls' must be followed by tool messages",
    "invalid model name",
    "context_length_exceeded",
])
def test_unrelated_failures_are_not_blamed_on_usage(msg):
    # Misattributing a real bug to the usage flag would turn it into a silent
    # "usage unavailable" instead of a visible failure.
    assert sa._is_stream_options_rejection(Exception(msg)) is False


def test_a_refusing_endpoint_is_remembered_and_stops_being_asked(monkeypatch):
    monkeypatch.setattr(sa, "_NO_USAGE_ENDPOINTS", set())
    creds = {"base_url": "https://llm.example/v1", "model": "some-model"}
    key = sa._endpoint_key(creds)

    seen: list[bool] = []

    def _fake_build_agent(*args, **kwargs):
        seen.append(kwargs["include_usage"])
        return object()

    monkeypatch.setattr("app.agent_runtime.agent_service.build_agent", _fake_build_agent)
    sa._make_agent(creds, [], "x")
    sa._NO_USAGE_ENDPOINTS.add(key)
    sa._make_agent(creds, [], "x")
    # Asked once, then never again for that endpoint.
    assert seen == [True, False]
    # A different endpoint is unaffected — one provider's gap isn't global.
    sa._make_agent({"base_url": "https://other/v1", "model": "m"}, [], "x")
    assert seen[-1] is True


# --- the endpoints the inspector reads ---------------------------------------

def test_inspector_endpoints_are_scoped_and_404_on_an_unknown_session(client):
    sid = client.post("/sessions", json={"title": "obs"}).json()["id"]
    for path in ("activity", "audit", "overview"):
        resp = client.get(f"/sessions/{sid}/{path}")
        assert resp.status_code == 200, path
        assert resp.json()["session_id"] == sid
        assert client.get(f"/sessions/does-not-exist/{path}").status_code == 404, path


def test_a_fresh_session_reports_an_empty_but_honest_overview(client):
    sid = client.post("/sessions", json={"title": "obs"}).json()["id"]
    body = client.get(f"/sessions/{sid}/overview").json()
    assert body["tool_calls"] == 0 and body["turns"] == []
    # Nothing measured yet — and the UI is told that, not handed a zero to show.
    assert body["usage"]["available"] is False
