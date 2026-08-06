"""v0.61.0 — the skill body stopped being paid for twice, and the fan-out got a ceiling.

Two independent findings, both measured before anything was written.

**The cross-turn skill re-read.** v0.54.0 added `active_skill_block`: the most
recently read skill rides in the STABLE half of the context so a multi-turn
investigation stops re-reading the same method every turn. But the only thing
stopping the agent was a sentence in the instructions — "do not read_skill it
again" — and `read_skill` had no check at all. A model that re-read paid for the
body twice in one turn: once in the cached context prefix, once as a tool result
that then rides every later step. Measured: the 20 skill bodies total 65,224
chars, mean 3,261, max 5,966.

The in-turn dedupe (`_call_key`) does NOT cover this — it catches the same call
twice within one turn, and this is a cross-turn repeat. That was checked before
concluding the gap was real.

**The unbounded tool fan-out.** v0.54.0 turned on `parallel_tool_calls`, and the
SDK's `max_function_tool_concurrency` default is None — documented as "starts ALL
function tool calls emitted in a turn". Nothing sat between the model's whim and
the endpoint, while the account survey right next door bounds its own probes to
`_PROBE_WORKERS = 4` for exactly that reason.
"""
from __future__ import annotations

import asyncio
import json
import sqlite3

import pytest

from app import migrations
from app.agent_runtime import session_agent as sa
from app.agent_runtime import session_tools
from app.skills import context as skill_context


class _Ctx:
    tool_name = "read_skill"
    run_config = None
    context = None
    usage = None


@pytest.fixture()
def conn():
    c = sqlite3.connect(":memory:", check_same_thread=False)
    c.row_factory = sqlite3.Row
    migrations.apply_migrations(c)
    c.execute("INSERT INTO sessions (id, title, created_at, updated_at) "
              "VALUES ('s1', 't', '2026-08-06T00:00:00Z', '2026-08-06T00:00:00Z')")
    c.commit()
    return c


def _prior_read(conn, name: str, when: str = "2026-08-06T00:00:01Z") -> None:
    """A read_skill from an EARLIER turn — what puts the body in active_skill."""
    conn.execute(
        "INSERT INTO tool_calls (id, run_id, tool_name, input_json_sanitized, "
        "output_json_sanitized, status, duration_ms, created_at, session_id) "
        "VALUES (?, NULL, 'read_skill', ?, '{}', 'success', 1, ?, 's1')",
        (f"tc-{name}-{when}", json.dumps({"name": name}), when))
    conn.commit()


def _read_skill(conn):
    from agents import function_tool
    tools = session_tools.build(conn, function_tool, [], session_id="s1")
    return [t for t in tools if t.name == "read_skill"][0]


def _a_skill() -> str:
    return skill_context.skill_names()[0]


# --- 1. the cross-turn re-read ----------------------------------------------

def test_the_skill_already_in_context_is_not_sent_again(conn):
    """The regression this half of the release exists for."""
    name = _a_skill()
    _prior_read(conn, name)
    out = asyncio.run(_read_skill(conn).on_invoke_tool(_Ctx(), json.dumps({"name": name})))
    payload = json.loads(out)
    assert payload["status"] == "already_loaded"
    assert payload["name"] == name
    body = skill_context.read_skill_text(name) or ""
    assert len(body) > 500, "fixture sanity: the body should be substantial"
    assert body not in out, "the full method was sent again"
    assert len(out) < 400, f"the pointer should be tiny, got {len(out)} chars"


def test_a_different_skill_still_loads_in_full(conn):
    """Only the ONE skill already in context is short-circuited. Refusing the
    others would turn a token saving into a lost capability."""
    names = skill_context.skill_names()
    _prior_read(conn, names[0])
    other = names[1]
    out = asyncio.run(_read_skill(conn).on_invoke_tool(_Ctx(), json.dumps({"name": other})))
    assert (skill_context.read_skill_text(other) or "") in out


def test_a_first_read_in_a_fresh_session_is_never_blocked(conn):
    """No prior read means nothing is in context, so the body must come."""
    name = _a_skill()
    out = asyncio.run(_read_skill(conn).on_invoke_tool(_Ctx(), json.dumps({"name": name})))
    assert (skill_context.read_skill_text(name) or "") in out


def test_the_active_skill_is_resolved_at_BUILD_time_not_call_time(conn):
    """The timing is the whole trick, so it is asserted rather than assumed.

    The tools are built before any of them can run, so the newest `read_skill`
    row belongs to a PREVIOUS turn. Resolving inside the tool instead would also
    see this turn's own row and refuse a first, legitimate read — the tool would
    block the very call that created the row.
    """
    name = _a_skill()
    tool = _read_skill(conn)          # built with NO prior read
    _prior_read(conn, name)           # a row appears afterwards
    out = asyncio.run(tool.on_invoke_tool(_Ctx(), json.dumps({"name": name})))
    # The already-built tool must still serve the body: at build time this
    # session had nothing in context.
    assert (skill_context.read_skill_text(name) or "") in out


def test_an_unknown_skill_name_still_reports_honestly(conn):
    out = asyncio.run(_read_skill(conn).on_invoke_tool(_Ctx(), json.dumps({"name": "nope"})))
    assert "Unknown skill" in out


def test_a_bookkeeping_failure_never_costs_the_capability():
    """Best-effort: if the lookup breaks, `read_skill` must behave exactly as it
    did before — a missed saving, never a missing method."""
    from agents import function_tool

    class _Broken:
        def execute(self, *a, **k):
            raise sqlite3.OperationalError("no such table")

    tools = session_tools.build(_Broken(), function_tool, [], session_id="s1")
    tool = [t for t in tools if t.name == "read_skill"][0]
    name = _a_skill()
    out = asyncio.run(tool.on_invoke_tool(_Ctx(), json.dumps({"name": name})))
    assert (skill_context.read_skill_text(name) or "") in out


def test_the_saving_is_worth_the_branch():
    """Assert the measured shape rather than trusting the changelog."""
    names = skill_context.skill_names()
    sizes = [len(skill_context.read_skill_text(n) or "") for n in names]
    assert len(names) >= 10
    assert sum(sizes) / len(sizes) > 1500, "bodies should be big enough to matter"


# --- 2. the fan-out ceiling --------------------------------------------------

def test_parallel_tool_execution_has_a_ceiling():
    assert isinstance(sa._MAX_PARALLEL_TOOLS, int)
    assert sa._MAX_PARALLEL_TOOLS >= 1


def test_the_ceiling_is_actually_handed_to_the_sdk():
    """A constant nothing reads is a comment. This asserts the wiring."""
    import inspect

    src = inspect.getsource(sa)
    assert "tool_execution=ToolExecutionConfig(" in src
    assert "max_function_tool_concurrency=_MAX_PARALLEL_TOOLS" in src


def test_the_sdk_still_has_the_knob_this_relies_on():
    """The SDK is pinned, but a lock bump must not silently drop the bound —
    the default is 'start ALL tool calls', so losing this is losing the ceiling.
    """
    from agents.run_config import RunConfig, ToolExecutionConfig

    assert "tool_execution" in RunConfig.__dataclass_fields__
    cfg = ToolExecutionConfig(max_function_tool_concurrency=sa._MAX_PARALLEL_TOOLS)
    assert cfg.max_function_tool_concurrency == sa._MAX_PARALLEL_TOOLS


def test_the_ceiling_stays_above_the_survey_bound():
    """This is one step of an interactive turn, not a bulk walk, so it should
    pace rather than throttle — and must not end up stricter than the batch path
    it was reasoned against."""
    from app.runs.account_discovery_run import _PROBE_WORKERS

    assert sa._MAX_PARALLEL_TOOLS >= _PROBE_WORKERS
