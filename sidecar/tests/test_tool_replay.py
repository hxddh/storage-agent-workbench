"""Cross-turn continuity: a prior assistant turn's persisted tool_activity is
replayed into the next turn's context as a bounded `tools_run` trace, so the
agent sees what it already probed and doesn't re-run the same checks. Reuses
already-persisted, already-sanitized data — no summarization/compaction.
"""
from app.agent_runtime import session_agent as sa


def _ctx(recent):
    return sa.build_session_context(
        {"id": "s1", "title": "t", "goal": "g", "status": "active"},
        {"known_facts": [], "findings": [], "open_questions": []},
        recent, agent_memory=[])


def test_assistant_tool_trace_is_replayed():
    recent = [
        {"role": "user", "content": "why is replication broken?"},
        {"role": "assistant", "content": "Checked replication.", "tool_activity": [
            {"tool": "get_bucket_config_detail", "target": "b · replication",
             "result": "available", "status": "completed"},
            {"tool": "head_bucket", "target": "b", "result": "ok", "status": "completed"},
        ]},
    ]
    ctx = _ctx(recent)
    asst = [m for m in ctx["recent_messages"] if m["role"] == "assistant"][0]
    assert "tools_run" in asst
    assert any("get_bucket_config_detail" in line for line in asst["tools_run"])
    # user messages get no tools_run
    user = [m for m in ctx["recent_messages"] if m["role"] == "user"][0]
    assert "tools_run" not in user


def test_started_records_excluded_and_bounded():
    # More than the replay cap so truncation triggers. The TAIL (most recent) is
    # kept and the elision marker leads the list at the head.
    n = sa._MAX_REPLAY_TOOLS + 10
    activity = [{"tool": "list_objects", "target": f"b/p{i}", "result": "50 keys",
                 "status": "completed"} for i in range(n)]
    activity.append({"tool": "preview_object", "target": "b/x", "status": "started"})
    recent = [{"role": "assistant", "content": "a", "tool_activity": activity}]
    ctx = _ctx(recent)
    tr = ctx["recent_messages"][0]["tools_run"]
    assert len(tr) == sa._MAX_REPLAY_TOOLS + 1  # bounded tail + a "+N earlier" line
    assert "earlier tool calls" in tr[0]  # marker leads (head), tail is kept
    assert any(f"b/p{n - 1}" in line for line in tr)      # newest kept
    assert not any("b/p0 " in line for line in tr)        # oldest elided
    assert not any("preview_object" in line for line in tr)  # 'started' dropped


def test_no_tool_activity_means_no_tools_run_key():
    recent = [{"role": "assistant", "content": "just prose", "tool_activity": []}]
    ctx = _ctx(recent)
    assert "tools_run" not in ctx["recent_messages"][0]


def test_replayed_trace_is_redacted():
    recent = [{"role": "assistant", "content": "a", "tool_activity": [
        {"tool": "head_object", "target": "b/AKIAIOSFODNN7EXAMPLE",
         "result": "ok", "status": "completed"}]}]
    ctx = _ctx(recent)
    line = ctx["recent_messages"][0]["tools_run"][0]
    assert "AKIAIOSFODNN7EXAMPLE" not in line  # redacted defensively
