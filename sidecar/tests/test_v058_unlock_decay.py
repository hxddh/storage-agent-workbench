"""v0.58.0 — the unlock memory is a window, and a locked tool is a correction.

Two defects that shipped together with v0.55.0's progressive tool disclosure:

1. **The unlock ratcheted.** ``seed_unlocked_groups`` read the session's ENTIRE
   ``tool_calls`` history, so a group touched once stayed open for every later
   turn. Measured: the gated schema block is 8,507 chars cold and 34,826 fully
   open — 26,319 chars (~6,579 tokens) re-sent on EVERY step, ~52,600 tokens on
   an 8-step turn, charged to a session that had long since moved on.

2. **A locked tool killed the turn.** The SDK defaults
   ``tool_not_found_behavior`` to ``"raise_error"``, and a gated tool is
   genuinely "not found" to the runtime. The model is told those tools exist, so
   naming one before unlocking it is predictable — and it raised
   ``ModelBehaviorError``, which this product does not classify as recoverable.
"""
from __future__ import annotations

import json
import sqlite3

import pytest

from app import migrations
from app.agent_runtime import session_agent as sa


@pytest.fixture()
def conn():
    c = sqlite3.connect(":memory:", check_same_thread=False)
    c.row_factory = sqlite3.Row
    migrations.apply_migrations(c)
    return c


def _call(conn, session_id: str, tool: str, when: str) -> None:
    conn.execute(
        "INSERT INTO tool_calls (id, run_id, tool_name, input_json_sanitized, "
        "output_json_sanitized, status, duration_ms, created_at, session_id) "
        "VALUES (?, NULL, ?, '{}', '{}', 'ok', 1, ?, ?)",
        (f"tc-{tool}-{when}-{conn.total_changes}", tool, when, session_id))
    conn.commit()


# --- 1. the unlock memory decays --------------------------------------------

def test_a_recent_group_is_still_seeded(conn):
    """The whole point of the memory: a continuing investigation must not re-pay
    the unlock round-trip on every follow-up question."""
    _call(conn, "s1", "review_bucket_security", "2026-08-06T00:00:01Z")
    assert "bucket_config" in sa.seed_unlocked_groups(conn, "s1")


def test_a_group_falls_out_once_the_window_slides_past(conn):
    """The fix. An old group is dropped, so the schema cost decays back down
    instead of ratcheting to the maximum and staying there for the session."""
    _call(conn, "s1", "review_bucket_security", "2026-08-06T00:00:01Z")
    # More recent work, entirely unrelated, longer than the window.
    for i in range(sa._UNLOCK_RECENT_CALLS):
        _call(conn, "s1", "list_object_versions", f"2026-08-06T01:{i // 60:02d}:{i % 60:02d}Z")
    seeded = sa.seed_unlocked_groups(conn, "s1")
    assert "storage_pileup" in seeded, "the recent work must stay open"
    assert "bucket_config" not in seeded, "the stale group must decay out"


def test_a_window_is_exactly_the_declared_size(conn):
    """Off-by-one guard: the Nth-most-recent call is still inside the window."""
    _call(conn, "s1", "review_bucket_security", "2026-08-06T00:00:00Z")
    for i in range(sa._UNLOCK_RECENT_CALLS - 1):
        _call(conn, "s1", "list_object_versions", f"2026-08-06T01:{i // 60:02d}:{i % 60:02d}Z")
    assert "bucket_config" in sa.seed_unlocked_groups(conn, "s1")


def test_a_one_heavy_turn_keeps_everything_it_just_used(conn):
    """A survey-style turn issues many calls at once. Everything it touched in
    that burst must still be open for the user's immediate follow-up."""
    for i in range(6):
        _call(conn, "s1", "survey_account", f"2026-08-06T02:00:{i:02d}Z")
        _call(conn, "s1", "review_bucket_security", f"2026-08-06T02:00:{i:02d}Z")
    seeded = sa.seed_unlocked_groups(conn, "s1")
    assert {"account_wide", "bucket_config"} <= seeded


def test_a_ordering_breaks_ties_by_rowid_not_just_timestamp(conn):
    """created_at has one-second resolution and a turn fires many calls inside
    one second. Ordering by timestamp alone would slice a burst arbitrarily."""
    same = "2026-08-06T03:00:00Z"
    _call(conn, "s1", "review_bucket_security", same)
    for _ in range(sa._UNLOCK_RECENT_CALLS):
        _call(conn, "s1", "list_object_versions", same)
    # The bucket_config call is the OLDEST row in that one-second burst, so a
    # correct LIMIT window drops it. Without the rowid tiebreak the result is
    # whatever SQLite happens to return.
    assert "bucket_config" not in sa.seed_unlocked_groups(conn, "s1")


def test_a_attachment_seed_survives_the_window(conn):
    """An attached file is a fact about THIS turn, not a memory — it must not be
    subject to the recency window at all."""
    for i in range(sa._UNLOCK_RECENT_CALLS + 5):
        _call(conn, "s1", "list_object_versions", f"2026-08-06T04:{i // 60:02d}:{i % 60:02d}Z")
    assert "uploaded_files" in sa.seed_unlocked_groups(conn, "s1", has_attachments=True)


def test_a_bookkeeping_failure_never_costs_a_capability():
    class _Broken:
        def execute(self, *a, **k):
            raise sqlite3.OperationalError("no such table")
    assert sa.seed_unlocked_groups(_Broken(), "s1") == set()
    assert sa.seed_unlocked_groups(None, "s1") == set()
    assert sa.seed_unlocked_groups(_Broken(), "s1", True) == {"uploaded_files"}


def test_a_the_saving_is_real_and_measured(conn):
    """The decay is only worth having if the gap it reclaims is large. Assert the
    measured shape rather than trusting the changelog."""
    from agents import function_tool

    def block(unlocked):
        tools = sa._build_tools(conn, function_tool, [], "s1", "t1", None,
                                model="gpt-4o", unlocked=set(unlocked))
        tools.append(sa._build_load_tools(function_tool, set(unlocked), []))
        sa._install_tool_gating(tools, set(unlocked))
        total = 0
        for t in tools:
            en = getattr(t, "is_enabled", True)
            if callable(en) and not en(None, None):
                continue
            total += len(json.dumps(
                {"name": t.name, "description": t.description,
                 "parameters": getattr(t, "params_json_schema", {})},
                separators=(",", ":")))
        return total

    cold, everything = block(set()), block(set(sa._TOOL_GROUPS))
    assert everything > cold * 3, "the gate should still be worth its complexity"
    # ~26k chars at measurement time. A loose floor: this asserts the saving
    # exists and is large, without pinning a number that legitimate tool-doc
    # edits would break.
    assert everything - cold > 20_000


# --- 2. a locked tool is a correction, not the end of the turn ---------------

class _Args:
    def __init__(self, kind: str, tool_name: str) -> None:
        self.kind = kind
        self.tool_name = tool_name
        self.default_message = "Tool not found"


def test_b_locked_tool_names_its_group_and_the_exact_call():
    msg = sa._make_tool_not_found_formatter(set())(
        _Args("tool_not_found", "list_object_versions"))
    assert msg is not None
    assert "storage_pileup" in msg
    # The signature must be the REAL one — teaching a wrong call shape would
    # cost another failed step. load_tools takes `group`, singular, not a list.
    assert 'load_tools(group="storage_pileup")' in msg
    assert "Nothing you have already gathered is lost" in msg


def test_b_every_gated_tool_gets_a_usable_hint():
    """Not just the one tool in the example: every gated tool must resolve."""
    fmt = sa._make_tool_not_found_formatter(set())
    for group, (_desc, names) in sa._TOOL_GROUPS.items():
        for name in names:
            msg = fmt(_Args("tool_not_found", name))
            assert msg is not None, name
            assert f'load_tools(group="{group}")' in msg, name


def test_b_already_unlocked_group_does_not_send_the_agent_to_reunlock():
    """The loop guard. Telling the agent to unlock what is already unlocked
    would have it call load_tools forever."""
    msg = sa._make_tool_not_found_formatter({"bucket_config"})(
        _Args("tool_not_found", "review_bucket_security"))
    assert msg is not None
    assert "already unlocked" in msg
    assert "load_tools(group=" not in msg


def test_b_unknown_name_defers_to_the_sdk_rather_than_inventing_a_group():
    assert sa._make_tool_not_found_formatter(set())(
        _Args("tool_not_found", "frobnicate_bucket")) is None


def test_b_other_error_kinds_are_left_alone():
    assert sa._make_tool_not_found_formatter(set())(
        _Args("approval_rejected", "list_object_versions")) is None


def test_b_formatter_never_raises():
    """It runs inside the SDK's error path; an exception there would replace a
    recoverable mistake with an unrecoverable one."""
    fmt = sa._make_tool_not_found_formatter(set())
    for bad in (object(), None, 42, "nope"):
        assert fmt(bad) is None


def test_b_core_tools_are_never_reported_as_gated():
    """A core tool is always enabled, so if it is ever 'not found' the cause is
    a wrong name, not a gate — the formatter must not claim otherwise."""
    fmt = sa._make_tool_not_found_formatter(set())
    for name in sa._CORE_TOOLS:
        assert fmt(_Args("tool_not_found", name)) is None, name
