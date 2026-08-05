"""v0.55.0 — stop sending 42 tool schemas to answer a two-tool question.

Measured on the real agent before this release: the fixed prefix the model
receives BEFORE any of the turn's own content is 49,135 chars (~12,284 tokens) —
19,552 of tool descriptions, 11,765 of parameter schemas, 4,204 of names and
wrapping, plus the system prompt, the skills catalog and the answer contract. It
is re-sent on EVERY step. On a realistic 8-tool turn (9 model requests) that is
91,566 tokens, **57% of the whole input bill**; with the skills catalog it is
69%. v0.53.0 and v0.54.0 optimized the context and the tool outputs — together
the other 32%.

So this release attacks the prefix itself, plus the two remaining places where
the SAME bytes were paid for repeatedly:

- **Tool groups.** CORE is always exposed; specialist tools are gated behind the
  SDK's per-step ``is_enabled`` and opened by ``load_tools`` (or by reading a
  skill whose method names them). Nothing is permanently hidden.
- **Schema titles.** Pydantic stamps ``"title": "Provider Id"`` next to
  ``provider_id`` — 30% of the parameter-schema bytes, restating the key.
- **The skill method.** A ~3,300-char body was re-read every turn because the
  replay keeps only a one-line trace of the read.
- **The replay caps.** Scaling message COUNT and message LENGTH by the same
  window factor made the replay grow with the square of the window.

And the frontend half's backend contract: every activity record now carries the
call's ``id``, its exact ``ok`` verdict and its measured ``duration_ms`` — all
three computed here long before this release and none of them ever sent.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3

import pytest

from app import migrations
from app.agent_runtime import session_agent as sa
from app.agent_runtime import session_tools


class _Ctx:
    """Minimal RunContextWrapper stand-in for invoking a real FunctionTool."""

    tool_name = "load_tools"
    run_config = None
    context = None
    usage = None


@pytest.fixture()
def conn():
    # check_same_thread=False mirrors app/db.py. It matters here: the SDK
    # dispatches a sync tool with asyncio.to_thread, so a tool body genuinely
    # runs off the creating thread — which is exactly what the concurrency test
    # below needs to reproduce.
    c = sqlite3.connect(":memory:", check_same_thread=False)
    c.row_factory = sqlite3.Row
    migrations.apply_migrations(c)
    return c


def _tools(conn, unlocked=None):
    from agents import function_tool
    unlocked = set() if unlocked is None else unlocked
    tools = sa._build_tools(conn, function_tool, [], "s1", "t1", None,
                            model="gpt-4o", unlocked=unlocked)
    tools.append(sa._build_load_tools(function_tool, unlocked, []))
    sa._install_tool_gating(tools, unlocked)
    return tools, unlocked


def _wire_chars(tools) -> int:
    """What actually goes over the wire this step, honouring is_enabled."""
    total = 0
    for t in tools:
        enabled = getattr(t, "is_enabled", True)
        if callable(enabled) and not enabled(None, None):
            continue
        total += len(json.dumps(
            {"type": "function", "function": {
                "name": t.name, "description": t.description,
                "parameters": t.params_json_schema}}, separators=(",", ":")))
    return total


# --- the gate ----------------------------------------------------------------


def test_a_gated_tool_is_not_offered_until_it_is_asked_for(conn):
    tools, unlocked = _tools(conn)
    review = [t for t in tools if t.name == "get_bucket_config_summary"][0]
    assert review.is_enabled(None, None) is False
    unlocked.add("bucket_config")
    # The SDK re-evaluates is_enabled on EVERY step, so the group is usable on
    # the very next request — no agent rebuild, nothing restarted.
    assert review.is_enabled(None, None) is True


def test_core_tools_are_never_gated(conn):
    tools, _ = _tools(conn)
    for name in ("list_providers", "head_bucket", "list_objects", "read_skill",
                 "note_fact", "load_tools"):
        tool = [t for t in tools if t.name == name][0]
        enabled = getattr(tool, "is_enabled", True)
        assert enabled is True or enabled(None, None) is True, name


def test_every_tool_is_either_core_or_in_exactly_one_group(conn):
    tools, _ = _tools(conn)
    names = {t.name for t in tools}
    for name in names:
        assert name in sa._CORE_TOOLS or name in sa._GROUP_OF_TOOL, \
            f"{name} is in no group — it would be gated with no way to unlock it"
    # And no tool is claimed by two groups.
    seen: set[str] = set()
    for _g, (_d, members) in sa._TOOL_GROUPS.items():
        assert not (seen & members)
        seen |= members


def test_an_ungrouped_tool_stays_visible_rather_than_disappearing(conn):
    tools, _ = _tools(conn)

    class _New:
        name = "some_future_tool"
        is_enabled = True

    t = _New()
    sa._install_tool_gating([t], set())
    # The default must fail OPEN: a tool added later without a group entry
    # merely misses the saving instead of silently vanishing from the agent.
    assert t.is_enabled is True


def test_load_tools_opens_the_group_and_says_what_it_opened():
    from agents import function_tool
    unlocked: set[str] = set()
    tool = sa._build_load_tools(function_tool, unlocked, [])
    out = json.loads(asyncio.run(
        tool.on_invoke_tool(_Ctx(), '{"group":"storage_pileup"}')))
    assert out["unlocked_group"] == "storage_pileup"
    assert "list_multipart_uploads" in out["tools_now_available"]
    assert unlocked == {"storage_pileup"}


def test_an_unknown_group_is_answered_with_the_valid_ones():
    from agents import function_tool
    tool = sa._build_load_tools(function_tool, set(), [])
    out = json.loads(asyncio.run(tool.on_invoke_tool(_Ctx(), '{"group":"nonsense"}')))
    # A correctable answer, not an opaque failure — the agent asked a reasonable
    # question and should be able to fix it in one step.
    assert out["valid_groups"] == sorted(sa._TOOL_GROUPS)


def test_the_group_catalog_names_every_group():
    catalog = sa.tool_group_catalog()
    for group in sa._TOOL_GROUPS:
        assert group in catalog
    # It must be cheap: it exists to REPLACE schemas, not to become one.
    assert len(catalog) < 1200, len(catalog)


def test_the_instructions_teach_the_unlock():
    assert "load_tools" in sa.INSTRUCTIONS
    for group in sa._TOOL_GROUPS:
        assert group in sa.INSTRUCTIONS


# --- what the gate is worth --------------------------------------------------


def test_a_core_only_turn_sends_a_fraction_of_the_schemas(conn):
    gated, _ = _tools(conn)
    everything, _ = _tools(conn, set(sa._TOOL_GROUPS))
    core = _wire_chars(gated)
    full = _wire_chars(everything)
    assert core < full * 0.30, f"core {core} vs full {full}"


def test_unlocking_one_group_still_beats_sending_everything(conn):
    one, _ = _tools(conn, {"bucket_config"})
    everything, _ = _tools(conn, set(sa._TOOL_GROUPS))
    assert _wire_chars(one) < _wire_chars(everything) * 0.45


def test_schema_titles_are_dropped(conn):
    tools, _ = _tools(conn)
    before = sum(len(json.dumps(t.params_json_schema, separators=(",", ":")))
                 for t in tools)
    removed = sa._strip_schema_titles(tools)
    after = sum(len(json.dumps(t.params_json_schema, separators=(",", ":")))
                for t in tools)
    assert removed > 0 and before - after == removed
    assert removed > before * 0.20, f"only {removed} of {before}"
    # `title` restates the property name; the strict-mode contract does not.
    for t in tools:
        schema = t.params_json_schema
        assert "title" not in schema
        for prop in (schema.get("properties") or {}).values():
            assert "title" not in prop
        if schema.get("properties"):
            assert schema.get("additionalProperties") is False


def test_a_parameter_that_is_literally_named_title_survives(conn):
    # `title` is a JSON-Schema keyword in one position and an ordinary parameter
    # NAME in another: record_finding(title, severity). A blind recursive delete
    # of every "title" key removed the PARAMETER while `required` still demanded
    # it — which would have made the tool uncallable and quietly cost the agent
    # its ability to record findings at all.
    tools, _ = _tools(conn)
    sa._strip_schema_titles(tools)
    finding = [t for t in tools if t.name == "record_finding"][0]
    assert set(finding.params_json_schema["properties"]) == {"title", "severity"}
    assert finding.params_json_schema["required"] == ["title", "severity"]
    for name in finding.params_json_schema["required"]:
        assert name in finding.params_json_schema["properties"], \
            "required names a property that no longer exists"


def test_stripping_titles_keeps_the_schema_usable(conn):
    tools, _ = _tools(conn)
    sa._strip_schema_titles(tools)
    head = [t for t in tools if t.name == "head_bucket"][0]
    props = head.params_json_schema["properties"]
    assert set(props) == {"provider_id", "bucket"}
    assert all(p["type"] == "string" for p in props.values())
    assert head.params_json_schema["required"] == ["provider_id", "bucket"]


# --- seeding: memory and facts, never a guess at the question ----------------


def test_a_session_that_already_used_a_group_starts_with_it_open(conn):
    conn.execute(
        "INSERT INTO tool_calls (id, run_id, session_id, tool_name, status, created_at) "
        "VALUES ('c1', NULL, 's1', 'review_bucket_security', 'success', '2026-08-05T00:00:00Z')")
    conn.commit()
    # A configuration investigation asks a second and a third configuration
    # question; re-charging the unlock round-trip every turn would cost more
    # than the gate saves. The tools genuinely ran — this is memory, not a plan.
    assert "bucket_config" in sa.seed_unlocked_groups(conn, "s1")


def test_an_attached_file_opens_the_file_tools(conn):
    assert sa.seed_unlocked_groups(conn, "s1", True) == {"uploaded_files"}


def test_a_fresh_session_starts_fully_closed(conn):
    assert sa.seed_unlocked_groups(conn, "s-new") == set()


def test_seeding_never_costs_the_agent_a_capability():
    class _Broken:
        def execute(self, *_a):
            raise sqlite3.OperationalError("no such table")

    # Bookkeeping must never be able to take tools away — worst case the agent
    # unlocks them itself.
    assert sa.seed_unlocked_groups(_Broken(), "s1") == set()


def test_reading_a_skill_opens_the_groups_its_method_names():
    unlocked: set[str] = set()
    opened = session_tools._unlock_groups_for_skill(
        "Call get_bucket_config_summary, then review_bucket_lifecycle.", unlocked)
    # A skill that names tools the agent cannot see reads as a broken method,
    # and making it spend a round-trip to ask for them costs more than the gate.
    assert opened == ["bucket_config"] and unlocked == {"bucket_config"}


def test_a_skill_that_needs_nothing_gated_opens_nothing():
    unlocked: set[str] = set()
    assert session_tools._unlock_groups_for_skill(
        "Start with head_bucket and list_objects.", unlocked) == []
    assert unlocked == set()


def test_a_tool_name_inside_a_longer_word_is_not_a_match():
    unlocked: set[str] = set()
    assert session_tools._unlock_groups_for_skill(
        "see xx_survey_account_helper for details", unlocked) == []


# --- the skill method rides along instead of being re-read -------------------


def test_a_loaded_skill_is_carried_into_the_next_turn(conn):
    conn.execute(
        "INSERT INTO tool_calls (id, run_id, session_id, tool_name, "
        " input_json_sanitized, status, created_at) VALUES "
        "('c1', NULL, 's1', 'read_skill', ?, 'success', '2026-08-05T00:00:00Z')",
        (json.dumps({"name": "storageops-triage"}),))
    conn.commit()
    block = sa.active_skill_block(conn, "s1")
    assert block and block["name"] == "storageops-triage"
    assert len(block["method"]) > 500          # the real method, not a stub
    assert "do not read_skill it again" in block["note"]


def test_the_carried_skill_sits_in_the_CACHEABLE_half_of_the_context():
    ctx = sa.build_session_context(
        {"title": "t", "goal": "g", "status": "active"},
        {"known_facts": [], "findings": [], "open_questions": [], "limitations": []},
        [{"role": "user", "content": "q"}],
        active_skill={"name": "s", "method": "m", "note": "n"})
    stable, volatile = sa.split_context_for_cache(ctx)
    # A tool result always lands after the volatile half and is never cached;
    # this is the whole point of carrying it here instead.
    assert "active_skill" in stable and "active_skill" not in volatile


def test_no_skill_read_means_nothing_is_carried(conn):
    assert sa.active_skill_block(conn, "s1") is None
    assert sa.active_skill_block(None, "s1") is None


def test_only_the_most_recent_skill_rides_along(conn):
    for i, name in enumerate(("storageops-triage", "storageops-lifecycle-cost")):
        conn.execute(
            "INSERT INTO tool_calls (id, run_id, session_id, tool_name, "
            " input_json_sanitized, status, created_at) VALUES "
            "(?, NULL, 's1', 'read_skill', ?, 'success', ?)",
            (f"c{i}", json.dumps({"name": name}), f"2026-08-05T00:0{i}:00Z"))
    conn.commit()
    # Carrying a second doubles the cost to cover a case read_skill still covers.
    assert sa.active_skill_block(conn, "s1")["name"] == "storageops-lifecycle-cost"


# --- the replay caps grow with the window, not with its square ---------------


@pytest.mark.parametrize("window", [128_000, 200_000, 500_000, 1_000_000, 2_000_000])
def test_the_replay_area_stays_linear_in_the_window(window):
    count, chars = sa._elastic_replay_caps("m", window)
    factor = max(1, window // 128_000)
    base = sa._MAX_MESSAGES * sa._MAX_REPLAY_MSG
    assert count * chars <= base * factor, f"{count}x{chars} at window {window:,}"


def test_a_small_window_model_is_bit_for_bit_unchanged():
    assert sa._elastic_replay_caps("gpt-4o", None) == (sa._MAX_MESSAGES, sa._MAX_REPLAY_MSG)


def test_a_large_window_still_gets_more_thread_than_a_small_one():
    small = sa._elastic_replay_caps("m", 128_000)
    large = sa._elastic_replay_caps("m", 1_000_000)
    assert large[0] > small[0] and large[0] * large[1] > small[0] * small[1]


# --- the prompt-cache ask ----------------------------------------------------


def test_the_cache_ask_is_made_by_default(monkeypatch):
    from app.agent_runtime import agent_service
    seen: dict = {}
    monkeypatch.setattr(agent_service, "build_agent",
                        lambda *a, **kw: seen.update(kw) or object())
    sa._make_agent({"base_url": "https://fresh.example", "model": "m"}, [], "hi", [])
    assert seen["prompt_cache_retention"] == sa._PROMPT_CACHE_RETENTION


def test_an_endpoint_that_refused_it_is_never_asked_again(monkeypatch):
    from app.agent_runtime import agent_service
    creds = {"base_url": "https://picky.example", "model": "m"}
    monkeypatch.setattr(sa, "_NO_CACHE_RETENTION_ENDPOINTS", {sa._endpoint_key(creds)})
    seen: dict = {}
    monkeypatch.setattr(agent_service, "build_agent",
                        lambda *a, **kw: seen.update(kw) or object())
    sa._make_agent(creds, [], "hi", [])
    # A cache hint is the least important thing in the request; compatibility wins.
    assert seen["prompt_cache_retention"] is None


def test_only_a_complaint_that_names_the_parameter_counts():
    assert sa._is_cache_retention_rejection(
        Exception("400: Unrecognized request argument: prompt_cache_retention")) is True
    # A real bug must never be able to hide behind a cost optimization.
    assert sa._is_cache_retention_rejection(Exception("400: context length exceeded")) is False
    assert sa._is_cache_retention_rejection(Exception("prompt_cache_retention is 24h")) is False


# --- what a thread row now knows about its call ------------------------------


def _live_tools(conn, activity):
    from agents import function_tool
    return session_tools.build(conn, function_tool, activity, session_id="s1")


def test_every_completed_record_carries_id_ok_and_duration(conn):
    activity: list = []
    tools = _live_tools(conn, activity)
    lp = [t for t in tools if t.name == "list_providers"][0]
    asyncio.run(lp.on_invoke_tool(_Ctx(), "{}"))
    done = [a for a in activity if a.get("status") != "started"]
    assert done and set(done[0]) >= {"id", "ok", "duration_ms", "tool", "result"}
    assert done[0]["ok"] is True
    assert done[0]["duration_ms"] is not None


def test_the_live_row_and_the_persisted_row_share_one_id(conn):
    activity: list = []
    tools = _live_tools(conn, activity)
    lp = [t for t in tools if t.name == "list_providers"][0]
    asyncio.run(lp.on_invoke_tool(_Ctx(), "{}"))
    call_id = [a for a in activity if a.get("status") != "started"][0]["id"]
    row = conn.execute("SELECT id, duration_ms, status FROM tool_calls "
                       "WHERE session_id = 's1'").fetchone()
    # One identity for the thread row and the persisted call: the row can be
    # opened to its real sanitized input/output instead of guessed at by time.
    assert row["id"] == call_id
    assert row["status"] == "success"


def test_started_and_completed_records_share_the_call_id(conn):
    activity: list = []
    tools = _live_tools(conn, activity)
    lp = [t for t in tools if t.name == "list_providers"][0]
    asyncio.run(lp.on_invoke_tool(_Ctx(), "{}"))
    started = [a for a in activity if a.get("status") == "started"]
    done = [a for a in activity if a.get("status") != "started"]
    assert started[0]["id"] == done[0]["id"]


def test_two_concurrent_calls_do_not_steal_each_others_bookkeeping(conn):
    """v0.54.0 turned on parallel tool calls; the SDK dispatches a sync tool with
    asyncio.to_thread, so two tool bodies genuinely run at once. The open-call
    slot they time against was a SINGLE shared dict, so the second rec() cleared
    the first call's state and the first note() then found nothing — no args, no
    duration, and a persisted input of {}."""
    import threading

    from app.repositories import cloud_providers as cloud_repo

    activity: list = []
    tools = _live_tools(conn, activity)
    lp = [t for t in tools if t.name == "list_providers"][0]

    # Force the overlap rather than hoping for it: both bodies sit inside their
    # rec()/note() window at the same instant, which is exactly the interleaving
    # parallel_tool_calls produces and the one a shared slot corrupts.
    barrier = threading.Barrier(2, timeout=10)
    real_list_all = cloud_repo.list_all

    def blocking_list_all(*a, **kw):
        barrier.wait()
        return real_list_all(*a, **kw)

    cloud_repo.list_all = blocking_list_all
    try:
        async def both():
            await asyncio.gather(lp.on_invoke_tool(_Ctx(), "{}"),
                                 lp.on_invoke_tool(_Ctx(), "{}"))

        asyncio.run(both())
    finally:
        cloud_repo.list_all = real_list_all
    done = [a for a in activity if a.get("status") != "started"]
    assert len(done) == 2
    # Each call kept its OWN identity and its own measurement.
    assert len({a["id"] for a in done}) == 2
    assert all(a.get("duration_ms") is not None for a in done)
    rows = conn.execute("SELECT id FROM tool_calls WHERE session_id = 's1'").fetchall()
    assert {r["id"] for r in rows} == {a["id"] for a in done}
