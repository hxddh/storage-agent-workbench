"""v1.12.0 — "Native all the way through" contracts.

One protocol (no message/turn shims), push transport, context compaction, and
the AGENTS.md instructions file. (v2.1 removed the plan tool, the approval
policy and the large-survey gate: a larger survey is bounded, never asked.)
"""

from __future__ import annotations

import json
import time

from tests.test_v111_native_turns import (  # noqa: F401 — shared helpers
    MODEL_KEY, _add_model_provider, _task, _wait_settled,
)


# --- W1: one protocol ------------------------------------------------------------


def test_no_message_or_turn_shims_remain(client):
    spec = client.get("/openapi.json").json()["paths"]
    paths = set(spec)
    retired = {"/sessions/{session_id}/messages/stream",
               "/sessions/{session_id}/turns/{turn_id}/cancel", "/sessions/{session_id}/turn",
               "/sessions/{session_id}/actions/prepare"}
    assert not (retired & paths), retired & paths
    # The message PAGE stays (GET); submitting one there is gone (POST).
    assert set(spec["/sessions/{session_id}/messages"]) == {"get"}
    assert "/agent-tasks/{task_id}/executions" in paths
    assert "/agent-tasks/{task_id}/compact" in paths
    # v2.1 — nothing asks for approval: no policy, no resolve route.
    assert "/settings/approval-policy" not in paths
    assert "/agent-tasks/{task_id}/decisions/{decision_id}/resolve" not in paths
    assert "/settings/instructions" in paths


def test_migration_030_adds_the_compaction_columns(client):
    from app.db import connect
    conn = connect()
    try:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(task_context_versions)")}
        assert {"summary_sanitized", "summary_through_seq"} <= cols
        head = conn.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0]
        assert int(head) >= 30  # 030 applied; v2.0 appends 031
    finally:
        conn.close()


# --- v2.1: a larger survey is bounded, never gated ----------------------------------


class _FT:
    def __call__(self, fn):
        fn.name = fn.__name__
        return fn


def _cloud_provider(client):
    r = client.post("/cloud-providers", json={
        "name": "acme", "provider_type": "aws_s3", "region": "us-east-1",
        "access_key": "AKIAEXAMPLEEXAMPLE", "secret_key": "s" * 40})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _running_execution(task_id):
    from app.db import connect
    from app.task_runtime import runtime, store
    conn = connect()
    try:
        store.ensure_task(conn, task_id)
        execution = store.create_execution(conn, task_id, "survey the account", "r-survey")
        store.set_execution_status(conn, execution["id"], store.EXEC_RUNNING)
        conn.commit()
    finally:
        conn.close()
    handle = runtime.LiveExecution(execution["id"], task_id)
    with runtime._lock:
        runtime._live[execution["id"]] = handle
    return execution, handle


def test_a_survey_above_the_default_cap_runs_bounded_without_a_decision(client, monkeypatch):
    from app.agent_runtime import session_action_tools
    from app.db import connect
    from app.task_runtime import runtime, store
    pid = _cloud_provider(client)
    task = _task(client)
    execution, handle = _running_execution(task["id"])
    seen: dict = {}

    def fake_execute_run(conn, body, turn_id, dedup_key, cancel_event=None, on_progress=None):
        seen["max_buckets"] = body.max_buckets
        raise RuntimeError("stop here — the bound is what this test checks")

    monkeypatch.setattr(session_action_tools, "_execute_run", fake_execute_run)
    conn = connect()
    try:
        tools = {t.name: t for t in session_action_tools.build(
            conn, _FT(), [], session_id=task["id"], turn_id=execution["turn_id"],
            cancel_event=handle.cancel_event)}
        survey = tools["survey_account"]
        survey(pid)
        assert seen["max_buckets"] is None
        t0 = time.monotonic()
        survey(pid, 300)
        assert time.monotonic() - t0 < 2.0  # never waits on anyone
        assert seen["max_buckets"] == 300
        survey(pid, 9000)
        assert seen["max_buckets"] == 500  # the hard cap, whatever is asked
        assert client.get(f"/agent-tasks/{task['id']}/decisions").json()["decisions"] == []
        assert store.get_execution(conn, execution["id"])["status"] == "running"
    finally:
        conn.close()
        with runtime._lock:
            runtime._live.pop(execution["id"], None)


# --- W5: context compaction -------------------------------------------------------


def _messages(client, task_id):
    return client.get(f"/sessions/{task_id}").json()["messages"]


def _seed_turns(client, task_id, n=3):
    from app.db import connect
    from app.repositories import session_activity
    from app.repositories import sessions as sessions_repo
    conn = connect()
    try:
        for i in range(n):
            sessions_repo.add_message(conn, task_id, "user", f"question {i} about acme-logs")
            mid = sessions_repo.add_message(
                conn, task_id, "assistant", f"answer {i}: bucket acme-logs is public",
                tool_activity=[{"id": f"c{i}", "tool": "head_bucket", "target": "acme-logs",
                                "result": "200", "ok": True, "status": "completed"}])
            session_activity.record_turn(conn, task_id, turn_id=f"t{i}", message_id=mid,
                                         model="gpt-4o-mini", duration_ms=10, tool_calls=1,
                                         usage={"input_tokens": 1000 * (i + 1),
                                                "output_tokens": 50, "total_tokens": 1050},
                                         budget_tokens=None, repeat_calls_avoided=0)
        conn.commit()
    finally:
        conn.close()


def test_compaction_step_is_bounded_redacted_and_replaces_the_older_replay(client, monkeypatch):
    from app.agent_runtime import compaction, session_agent
    from app.db import connect
    from app.task_runtime import store
    _add_model_provider(client)
    task = _task(client)
    _seed_turns(client, task["id"], 3)
    prompts: list = []

    def fake_step(creds, messages, prior):
        prompts.append(compaction.build_prompt(messages, prior))
        return ("<think>hidden</think>Summary: acme-logs is public; key AKIA"
                "ABCDEFGHIJKLMNOP was seen. " + "x" * 3000)

    monkeypatch.setattr(compaction, "COMPACT_STEP", fake_step)
    conn = connect()
    try:
        # 1000-token turns on a 128k window: nothing to do automatically.
        creds = {"model": "gpt-4o-mini", "context_window": 128_000}
        assert compaction.should_compact(conn, task["id"], creds) is False
        # The last turn reported 3000 input tokens: an operator-declared 3500
        # window crosses 80 %.
        assert compaction.should_compact(conn, task["id"],
                                         {"model": "gpt-4o-mini", "context_window": 3500})
        # Usage not reported → never compacts on a guess.
        assert compaction.last_input_tokens(conn, "nope") is None

        out = compaction.compact(conn, task["id"], creds, None)
        assert out and out["summary_chars"] == compaction.MAX_SUMMARY_CHARS
        assert out["before_tokens"] == 3000 and out["after_tokens"] > 0
        latest = store.latest_context(conn, task["id"])
        assert latest["summary"].startswith("Summary: acme-logs is public")
        assert "hidden" not in latest["summary"] and "AKIAABCDEFGHIJKLMNOP" not in latest["summary"]
        msgs = _messages(client, task["id"])
        assert latest["summary_through_seq"] == msgs[-1]["seq"]
        # The prompt the step saw: the sanitized replay only, marked.
        assert compaction.COMPACT_MARKER in prompts[0]
        assert "question 0 about acme-logs" in prompts[0] and "tools run: head_bucket" in prompts[0]

        # The next prompt carries the summary in the STABLE half and replays
        # nothing older than the compaction point.
        session = dict(conn.execute("SELECT * FROM sessions WHERE id = ?", (task["id"],)).fetchone())
        _p, _n, ctx = session_agent._build_prompt(session, {}, msgs, "and now?", conn)
        assert ctx["conversation_summary"].startswith("Summary: acme-logs is public")
        assert ctx["recent_messages"] == []
        stable, volatile = session_agent.split_context_for_cache(ctx)
        assert "conversation_summary" in stable and "conversation_summary" not in volatile

        # A later message IS replayed; the summary carries onto later versions.
        from app.repositories import sessions as sessions_repo
        from app.task_runtime import context as task_context
        sessions_repo.add_message(conn, task["id"], "user", "newer question")
        conn.commit()
        task_context.refresh(conn, task["id"])
        conn.commit()
        assert store.latest_context(conn, task["id"])["summary"] == latest["summary"]
        msgs2 = _messages(client, task["id"])
        _p, _n, ctx2 = session_agent._build_prompt(session, {}, msgs2, "and now?", conn)
        assert [m["content"] for m in ctx2["recent_messages"]] == ["newer question"]
        # A second compaction folds the prior summary in and covers the new tail.
        out2 = compaction.compact(conn, task["id"], creds, None)
        assert out2 and "Earlier summary" in prompts[1] and "newer question" in prompts[1]
    finally:
        conn.close()


def test_compact_endpoint_is_idle_only_and_needs_a_model(client, monkeypatch):
    from app.agent_runtime import compaction
    task = _task(client)
    _seed_turns(client, task["id"], 1)
    assert client.post(f"/agent-tasks/{task['id']}/compact").status_code == 422
    _add_model_provider(client)
    monkeypatch.setattr(compaction, "COMPACT_STEP", lambda creds, msgs, prior: None)
    r = client.post(f"/agent-tasks/{task['id']}/compact")
    assert r.status_code == 200 and r.json()["compacted"] is False
    monkeypatch.setattr(compaction, "COMPACT_STEP",
                        lambda creds, msgs, prior: "Summary: one turn about acme-logs.")
    r = client.post(f"/agent-tasks/{task['id']}/compact")
    assert r.status_code == 200 and r.json()["compacted"] is True
    assert r.json()["before_tokens"] == 1000 and r.json()["after_tokens"] > 0
    events = client.get(f"/agent-tasks/{task['id']}/events").json()["events"]
    ev = [e for e in events if e["event_type"] == "context.compacted"]
    assert ev and ev[-1]["execution_id"] == "" and ev[-1]["payload"]["summary_chars"] > 0
    assert client.post("/agent-tasks/nope/compact").status_code == 404
    # Busy task → 409.
    execution, handle = _running_execution(task["id"])
    try:
        assert client.post(f"/agent-tasks/{task['id']}/compact").status_code == 409
    finally:
        from app.task_runtime import runtime
        with runtime._lock:
            runtime._live.pop(execution["id"], None)


def test_runtime_compacts_before_the_model_loop_when_the_window_is_full(client, monkeypatch):
    # v2.2 — on the streamed path (fake endpoint): the prompt asserted is the
    # one the model really received.
    from app.agent_runtime import compaction
    from tests.fake_model import FakeModel, text_turn
    task = _task(client)
    _seed_turns(client, task["id"], 2)
    monkeypatch.setattr(compaction, "COMPACT_STEP",
                        lambda creds, msgs, prior: "Summary: two turns; acme-logs public.")
    with FakeModel([text_turn("Continuing.")]) as model:
        # A declared window small enough that the last turn (2000 tokens) fills it.
        client.post("/model-providers", json={
            "name": "fake", "provider_type": "openai-compatible", "base_url": model.base_url,
            "model": "fake-model", "api_key": "not-a-real-key", "context_window": 2400})
        ex = client.post(f"/agent-tasks/{task['id']}/executions",
                         json={"direction": "keep going"}).json()["execution"]
        assert _wait_settled(client, task["id"], ex["id"])["status"] == "completed"
    prompt = json.dumps(model.requests[0]["messages"])
    events = client.get(f"/agent-tasks/{task['id']}/events").json()["events"]
    ev = [e for e in events if e["event_type"] == "context.compacted"]
    assert len(ev) == 1 and ev[0]["execution_id"] == ex["id"]
    assert ev[0]["payload"]["before_tokens"] == 2000
    assert "Summary: two turns; acme-logs public." in prompt
    assert "question 0 about acme-logs" not in prompt
    msg = [m for m in _messages(client, task["id"]) if m["role"] == "assistant"][-1]
    assert msg["turn_items"][0] == {"kind": "compacted", "before_tokens": 2000,
                                    "after_tokens": ev[0]["payload"]["after_tokens"]}


def test_on_demand_compaction_is_carried_by_the_next_execution_once(client, monkeypatch):
    from app.agent_runtime import compaction, session_agent
    _add_model_provider(client)
    task = _task(client)
    _seed_turns(client, task["id"], 1)
    monkeypatch.setattr(compaction, "COMPACT_STEP",
                        lambda creds, msgs, prior: "Summary: one turn about acme-logs.")
    assert client.post(f"/agent-tasks/{task['id']}/compact").json()["compacted"] is True
    monkeypatch.setattr(session_agent, "SESSION_LOOP", lambda spec: {
        "answer": "ok", "skills_used": [], "skills_offered": [], "evidence_used": [],
        "evidence_gaps": [], "tool_activity": [], "turn_items": []})
    for direction, expect_marker in (("next", True), ("after that", False)):
        ex = client.post(f"/agent-tasks/{task['id']}/executions",
                         json={"direction": direction}).json()["execution"]
        assert _wait_settled(client, task["id"], ex["id"])["status"] == "completed"
        events = client.get(f"/agent-tasks/{task['id']}/events").json()["events"]
        mine = [e for e in events if e["event_type"] == "context.compacted"
                and e["execution_id"] == ex["id"]]
        msg = [m for m in _messages(client, task["id"]) if m["role"] == "assistant"][-1]
        if expect_marker:
            assert len(mine) == 1 and mine[0]["payload"]["before_tokens"] == 1000
            assert msg["turn_items"][0]["kind"] == "compacted"
        else:
            assert mine == [] and not msg["turn_items"]


# --- W7: AGENTS.md ----------------------------------------------------------------


def test_instructions_file_is_bounded_redacted_and_in_the_stable_prompt_half(client, tmp_path, monkeypatch):
    from app.agent_runtime import instructions, session_agent
    from app.db import connect
    assert client.get("/settings/instructions").json()["loaded"] is False
    (tmp_path / "elsewhere").mkdir()
    f = tmp_path / "elsewhere" / "AGENTS.md"
    f.write_text("# House rules\nReport in English. Never touch bucket prod-archive.\n"
                 "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n"
                 + ("filler line\n" * 2000), encoding="utf-8")
    monkeypatch.setenv(instructions.ENV_OVERRIDE, str(f))
    st = client.get("/settings/instructions").json()
    assert st["loaded"] is True and st["truncated"] is True and st["error"] is None
    assert st["chars"] <= instructions.MAX_CHARS + 100 and "text" not in st
    assert st["path"] == str(f)
    task = _task(client)
    conn = connect()
    try:
        session = dict(conn.execute("SELECT * FROM sessions WHERE id = ?", (task["id"],)).fetchone())
        prompt, _n, _ctx = session_agent._build_prompt(session, {}, [], "hello", conn)
    finally:
        conn.close()
    assert "operator_instructions (AGENTS.md" in prompt
    assert "Never touch bucket prod-archive" in prompt
    assert "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" not in prompt
    assert "[instructions truncated at 8000 characters]" in prompt
    # The block sits with the stable prefix, before this turn's question.
    assert prompt.index("operator_instructions") < prompt.index("configured_providers")
    assert prompt.index("operator_instructions") < prompt.index("Direction:")
    # Default location: the data directory.
    monkeypatch.delenv(instructions.ENV_OVERRIDE)
    assert instructions.path().name == "AGENTS.md"
    assert client.get("/settings/instructions").json()["loaded"] is False


# --- W2/W3 leftovers: the durable log carries tool timing ----------------------------


def test_tool_events_carry_wall_clock_stamps(client, monkeypatch):
    from app.agent_runtime import session_agent
    _add_model_provider(client)
    task = _task(client)

    def fake_loop(spec):
        spec["activity"].append({"id": "c1", "tool": "head_bucket", "target": "acme",
                                 "result": "200", "ok": True, "status": "completed",
                                 "started_at": "2026-09-02T00:00:00Z",
                                 "finished_at": "2026-09-02T00:00:02Z", "duration_ms": 2000})
        return {"answer": "Done.", "skills_used": [], "skills_offered": [], "evidence_used": [],
                "evidence_gaps": [], "tool_activity": list(spec["activity"]),
                "turn_items": [{"kind": "tool", "id": "c1", "tool": "head_bucket"}]}

    monkeypatch.setattr(session_agent, "SESSION_LOOP", fake_loop)
    ex = client.post(f"/agent-tasks/{task['id']}/executions", json={"direction": "go"}).json()["execution"]
    assert _wait_settled(client, task["id"], ex["id"])["status"] == "completed"
    events = client.get(f"/agent-tasks/{task['id']}/events").json()["events"]
    done = [e for e in events if e["event_type"] == "tool.completed"][0]["payload"]
    assert done["started_at"] == "2026-09-02T00:00:00Z" and done["finished_at"].endswith("02Z")
    assert done["duration_ms"] == 2000
    msg = [m for m in _messages(client, task["id"]) if m["role"] == "assistant"][-1]
    assert msg["tool_activity"][0]["finished_at"] == "2026-09-02T00:00:02Z"
    assert json.dumps(msg["turn_items"]) == json.dumps([{"kind": "tool", "id": "c1"}])
