"""v0.56.0 — pin what was verified, bound what could hang, open what was written.

**Dependencies.** The Python side was the only one without a lockfile (the
frontend has package-lock.json, Rust has Cargo.lock), so `pip install -e
./sidecar` resolved pyproject's deliberately loose ranges at INSTALL time and
three environments disagreed: v0.55.0 was developed against openai-agents 0.17.8
while CI validated it against 0.19.4, and a packaged build got whatever was
newest that day. Both passed, which was luck — v0.55.0's whole token saving rests
on `is_enabled` being re-evaluated every step, and `>=0.17,<1` would have let a
0.20 that changed it in silently.

**Timeouts.** The SDK has offered `timeout_seconds` all along and nothing set it,
so a single tool call had no time bound at all — in a product whose job is
diagnosing storage endpoints, where an endpoint that completes a handshake and
then goes silent is a routine finding.

**The catalog.** After v0.55.0 shrank the tool block, the skills catalog was the
second-largest per-step cost: 7,542 chars for 20 skills of which a turn loads at
most one or two.

**Call detail.** Every call's sanitized input/output has been persisted since
v0.45.0 and v0.55.0 gave the thread row the same id — but nothing could ask for
one row.
"""

from __future__ import annotations

import re
import sqlite3
from pathlib import Path

import pytest

from app import migrations
from app.agent_runtime import agent_service
from app.agent_runtime import session_agent as sa
from app.repositories import session_activity
from app.skills import context as skill_context

REPO = Path(__file__).resolve().parent.parent
LOCK = REPO / "requirements.lock"


# --- the lockfile ------------------------------------------------------------


def test_the_lockfile_exists_and_pins_exactly():
    assert LOCK.exists(), "the sidecar must ship a lockfile like the other two stacks"
    pins = [ln.strip() for ln in LOCK.read_text().splitlines()
            if ln.strip() and not ln.startswith("#")]
    assert pins, "lockfile has no pins"
    for line in pins:
        # A range in a lockfile is not a pin — it would reintroduce exactly the
        # install-time resolution this file exists to remove.
        assert re.fullmatch(r"[A-Za-z0-9._-]+==[^=<>!,\s]+", line), line


def test_every_declared_runtime_dependency_is_pinned():
    text = (REPO / "pyproject.toml").read_text()
    # ONLY `[project].dependencies` — the runtime closure that ships. The dev and
    # packaging extras are deliberately outside the lock: they are not shipped,
    # and pinning them would turn a routine pytest/ruff bump into a lockfile
    # conflict for no reproducibility gain.
    # Terminate on a `]` at the start of a line: a bare `]` split lands inside
    # `"uvicorn[standard]>=0.27"` and silently parses one dependency.
    block = re.split(r"\n\]", text.split("dependencies = [", 1)[1], maxsplit=1)[0]
    deps = re.findall(r'^\s*"([A-Za-z0-9._-]+)(?:\[[^\]]*\])?[><=!~]', block, re.M)
    assert len(deps) >= 10, f"parsed only {deps} — the block shape changed"
    pinned = {ln.split("==")[0].lower().replace("_", "-")
              for ln in LOCK.read_text().splitlines()
              if "==" in ln and not ln.startswith("#")}
    missing = [d for d in deps if d.lower().replace("_", "-") not in pinned]
    assert not missing, f"declared but unpinned: {missing}"


def test_the_agent_sdk_is_pinned_at_or_above_what_v055_needs():
    pin = [ln for ln in LOCK.read_text().splitlines()
           if ln.startswith("openai-agents==")][0]
    major, minor = (int(x) for x in pin.split("==")[1].split(".")[:2])
    assert (major, minor) >= (0, 19), pin


def test_the_primitives_v055_depends_on_are_present_in_the_pinned_sdk():
    import inspect

    import agents.run as run_mod
    from agents.agent import Agent
    from agents.tool import FunctionTool

    # v0.55.0's entire token saving rests on these three facts. If a future bump
    # breaks one, the gate silently stops gating (or stops exposing tools) and
    # this is the test that says so.
    assert "all_tools = await get_all_tools" in inspect.getsource(run_mod)
    assert "is_enabled" in inspect.getsource(Agent.get_all_tools)
    assert FunctionTool.__dataclass_params__.frozen is False


# --- per-tool timeouts -------------------------------------------------------


@pytest.fixture()
def conn():
    c = sqlite3.connect(":memory:", check_same_thread=False)
    c.row_factory = sqlite3.Row
    migrations.apply_migrations(c)
    return c


def _tools(conn):
    from agents import function_tool
    return sa._build_tools(conn, function_tool, [], "s1", "t1", None,
                           model="gpt-4o", unlocked=set(sa._TOOL_GROUPS))


def test_every_tool_gets_a_wall_clock_bound(conn):
    tools = _tools(conn)
    bounded = sa._install_tool_timeouts(tools)
    assert bounded == len(tools)
    for t in tools:
        assert t.timeout_seconds and t.timeout_seconds > 0, t.name


def test_a_timeout_reaches_the_agent_as_evidence_not_as_a_crash(conn):
    tools = _tools(conn)
    sa._install_tool_timeouts(tools)
    for t in tools:
        # "this probe never came back" is itself a diagnosis; killing the turn
        # would throw away everything the turn had already established.
        assert t.timeout_behavior == "error_as_result", t.name


def test_the_bucket_walking_tools_get_longer_than_a_single_probe(conn):
    tools = _tools(conn)
    sa._install_tool_timeouts(tools)
    by = {t.name: t.timeout_seconds for t in tools}
    assert by["head_bucket"] == sa._TOOL_TIMEOUT_S
    for slow in ("survey_account", "review_bucket_config"):
        if slow in by:
            assert by[slow] == sa._SLOW_TOOL_TIMEOUT_S
            assert by[slow] > by["head_bucket"]


def test_a_foreign_tool_object_is_skipped_not_crashed_on():
    class _Plain:
        name = "not_an_sdk_tool"

    assert sa._install_tool_timeouts([_Plain()]) == 0


# --- temperature -------------------------------------------------------------


def test_the_investigator_pins_its_own_temperature(monkeypatch):
    seen: dict = {}
    monkeypatch.setattr(agent_service, "build_agent",
                        lambda *a, **kw: seen.update(kw) or object())
    sa._make_agent({"base_url": "https://x.example", "model": "m"}, [], "hi", [])
    # Never set before, so every endpoint applied its own default. An operator
    # comparing today's answer to last week's should be able to assume the
    # difference is the bucket, not the decoder.
    assert seen["temperature"] == agent_service.AGENT_TEMPERATURE
    assert 0 < agent_service.AGENT_TEMPERATURE < 1


def test_an_operator_override_wins(monkeypatch):
    seen: dict = {}
    monkeypatch.setattr(agent_service, "build_agent",
                        lambda *a, **kw: seen.update(kw) or object())
    sa._make_agent({"base_url": "https://x.example", "model": "m", "temperature": 0.9},
                   [], "hi", [])
    assert seen["temperature"] == 0.9


# --- the skills catalog ------------------------------------------------------


def test_the_catalog_carries_one_whole_sentence_per_skill():
    for item in skill_context.catalog():
        line = skill_context.routing_line(item["description"])
        assert line, item["name"]
        # A character cut would slice mid-list through the very error codes that
        # make a skill findable; a sentence boundary cannot.
        assert not line.endswith("…")
        assert len(line) >= 40, (item["name"], line)


def test_the_catalog_is_materially_smaller_than_the_full_descriptions():
    full = sum(len(" ".join(i["description"].split())) for i in skill_context.catalog())
    trimmed = sum(len(skill_context.routing_line(i["description"]))
                  for i in skill_context.catalog())
    assert trimmed < full * 0.65, f"{trimmed} vs {full}"


def test_every_skill_is_still_listed_and_loadable():
    text = skill_context.catalog_text()
    for name in skill_context.skill_names():
        assert name in text
        assert skill_context.read_skill_text(name), name


def test_a_description_with_no_sentence_break_survives_whole():
    assert skill_context.routing_line("one clause with no terminator") == \
        "one clause with no terminator"
    assert skill_context.routing_line("") == ""


# --- one call by id ----------------------------------------------------------


def _insert(conn, call_id: str, session_id: str = "s1"):
    conn.execute(
        "INSERT INTO tool_calls (id, run_id, session_id, tool_name, "
        " input_json_sanitized, output_json_sanitized, status, duration_ms, created_at) "
        "VALUES (?, NULL, ?, 'list_objects', ?, ?, 'success', 42, '2026-08-05T00:00:00Z')",
        (call_id, session_id, '{"target":"acme-logs","prefix":"logs/"}',
         '{"summary":"1000 keys"}'))
    conn.commit()


def test_a_call_can_be_read_back_by_the_id_its_thread_row_carries(conn):
    _insert(conn, "c1")
    row = session_activity.get_call(conn, "s1", "c1")
    assert row["input"]["prefix"] == "logs/"
    assert row["output"]["summary"] == "1000 keys"
    assert row["duration_ms"] == 42


def test_a_call_id_from_another_session_is_not_readable(conn):
    _insert(conn, "c1", session_id="other")
    # The id alone would otherwise let any session's call be read through any
    # other session's URL.
    assert session_activity.get_call(conn, "s1", "c1") is None


def test_an_unknown_id_is_simply_absent(conn):
    assert session_activity.get_call(conn, "s1", "nope") is None
