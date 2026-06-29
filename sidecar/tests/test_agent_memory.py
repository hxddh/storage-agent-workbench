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
        assert set(by_name) == {"note_fact", "record_finding", "note_open_question"}

        by_name["note_fact"]("bucket acme is path-style only", "high")
        by_name["record_finding"]("bucket is world-readable", "critical")
        by_name["note_open_question"]("is versioning required here?")

        mem = sessions_repo.list_agent_memory(conn, sid)
    kinds = sorted(m["kind"] for m in mem)
    assert kinds == ["fact", "finding", "open_question"]
    finding = next(m for m in mem if m["kind"] == "finding")
    assert finding["severity"] == "critical"


def test_memory_secret_is_redacted_before_storage(client):
    leak = "AKIAIOSFODNN7EXAMPLE"
    with _db() as conn:
        sid = _session(conn)
        tools = {t.name: t for t in session_memory_tools.build(conn, _FakeFunctionTool(), sid, [])}
        tools["note_fact"](f"the access key is {leak}", "high")
        mem = sessions_repo.list_agent_memory(conn, sid)
    assert leak not in mem[0]["text"]  # redacted


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
