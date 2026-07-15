"""Tests for the in-chat agent's working memory (Round A).

The agent records facts/findings/open-questions that persist across turns and
are fed back into the next turn's context as ``agent_memory``. Secrets are
redacted before storage like every other agent output.
"""

import json
import sqlite3

from app import config
from app.agent_runtime import session_agent, session_memory_tools
from app.repositories import sessions as sessions_repo


class _FakeFunctionTool:
    """Mimic the SDK's @function_tool: keep the callable, expose .name."""

    def __call__(self, fn):
        fn.name = fn.__name__
        return fn


def _session(conn) -> str:
    from app.models.schemas import SessionCreate
    return sessions_repo.create(conn, SessionCreate(title="t", goal="g"))


def _db():
    conn = sqlite3.connect(str(config.db_path()))
    conn.row_factory = sqlite3.Row
    return conn


def test_memory_tools_persist_and_list(client):
    with _db() as conn:
        sid = _session(conn)
        tools = session_memory_tools.build(conn, _FakeFunctionTool(), sid, [])
        by_name = {t.name: t for t in tools}
        assert set(by_name) == {"note_fact", "record_finding", "note_open_question",
                                "update_memory_item", "resolve_memory_item"}

        by_name["note_fact"]("bucket acme is path-style only", "high")
        by_name["record_finding"]("bucket is world-readable", "critical")
        by_name["note_open_question"]("is versioning required here?")

        mem = sessions_repo.list_agent_memory(conn, sid)
    kinds = sorted(m["kind"] for m in mem)
    assert kinds == ["fact", "finding", "open_question"]
    finding = next(m for m in mem if m["kind"] == "finding")
    assert finding["severity"] == "critical"


def test_memory_update_and_resolve_lifecycle(client):
    """Fix 9: memory items are not write-only. They can be corrected (update)
    and closed (resolve); a resolved item stops being replayed and no longer
    counts against the tail cap. Exact-duplicate adds are deduped."""
    with _db() as conn:
        sid = _session(conn)
        tools = {t.name: t for t in session_memory_tools.build(conn, _FakeFunctionTool(), sid, [])}
        r = json.loads(tools["note_fact"]("region is us-west-1", "medium"))
        fact_id = r["id"]
        # Dedup: an identical add returns the SAME id, no second row.
        r2 = json.loads(tools["note_fact"]("region is us-west-1", "medium"))
        assert r2["id"] == fact_id
        assert len(sessions_repo.list_agent_memory(conn, sid)) == 1

        # Correct it.
        upd = json.loads(tools["update_memory_item"](fact_id, "region is us-east-1"))
        assert upd["action"] == "updated"
        mem = sessions_repo.list_agent_memory(conn, sid)
        assert mem[0]["text"] == "region is us-east-1"

        # Resolve it → excluded from the active replay set.
        res = json.loads(tools["resolve_memory_item"](fact_id, "confirmed by user"))
        assert res["action"] == "resolved"
        assert sessions_repo.list_agent_memory(conn, sid) == []

        # Updating/resolving an unknown id is a clean error, not a crash.
        assert "error" in json.loads(tools["update_memory_item"]("nope", "x"))
        assert "error" in json.loads(tools["resolve_memory_item"]("nope"))


def test_memory_secret_is_redacted_before_storage(client):
    leak = "AKIAIOSFODNN7EXAMPLE"
    with _db() as conn:
        sid = _session(conn)
        tools = {t.name: t for t in session_memory_tools.build(conn, _FakeFunctionTool(), sid, [])}
        tools["note_fact"](f"the access key is {leak}", "high")
        mem = sessions_repo.list_agent_memory(conn, sid)
    assert leak not in mem[0]["text"]  # redacted


def test_memory_keeps_most_recent_when_over_limit(client):
    with _db() as conn:
        sid = _session(conn)
        tools = {t.name: t for t in session_memory_tools.build(conn, _FakeFunctionTool(), sid, [])}
        for i in range(5):
            tools["note_fact"](f"fact{i}", "medium")
        mem = sessions_repo.list_agent_memory(conn, sid, limit=3)
    # The newest 3, returned oldest-first.
    assert [m["text"] for m in mem] == ["fact2", "fact3", "fact4"]


def test_memory_block_surfaces_most_recent_per_kind():
    # More findings than the cap (synced with summary_builder.MAX_FINDINGS=50):
    # the context block keeps only the most recent _MAX_FINDINGS.
    cap = session_agent._MAX_FINDINGS
    n = cap + 10
    mem = [{"kind": "finding", "text": f"f{i}", "severity": "info"} for i in range(n)]
    block = session_agent._build_agent_memory_block(mem)
    titles = [x["title"] for x in block["recorded_findings"]]
    assert len(titles) == cap
    assert titles[0] == f"f{n - cap}" and titles[-1] == f"f{n - 1}"  # newest survive


def test_no_memory_tools_without_session():
    # No session id → nothing to record into; no tools, no DB access.
    assert session_memory_tools.build(object(), _FakeFunctionTool(), None, []) == []


def test_memory_feeds_into_next_turn_context(client):
    with _db() as conn:
        sid = _session(conn)
        tools = {t.name: t for t in session_memory_tools.build(conn, _FakeFunctionTool(), sid, [])}
        tools["note_fact"]("region is us-east-1", "high")
        tools["record_finding"]("public read enabled", "high")
        memory = sessions_repo.list_agent_memory(conn, sid)

    ctx = session_agent.build_session_context(
        {"id": sid, "title": "t", "goal": "g"}, {}, [], memory)
    block = ctx["agent_memory"]
    assert any(f["text"] == "region is us-east-1" for f in block["recorded_facts"])
    assert any(f["title"] == "public read enabled" for f in block["recorded_findings"])
    # And it is real JSON-serializable context with no secret-shaped content.
    json.dumps(ctx, default=str)
