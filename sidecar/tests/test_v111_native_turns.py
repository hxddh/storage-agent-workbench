"""v1.11.0 — Codex-style turns: per-segment streaming, durable turn items,
and the runtime split. (v2.1 removed the inline approval pause and the model
plan: nothing waits for a human, and there is no plan item.)

Take the UI away: the runtime alone must produce a transcript of commentary
segments and tool rows before the answer, and persist it.
"""

from __future__ import annotations

import asyncio
import threading
import time

from app.agent_runtime import session_agent

MODEL_KEY = "sk-TESTKEY-DONOTLEAK-0001"


def _task(client, title="Diagnose slow reads"):
    return client.post("/sessions", json={"title": title, "goal": "diagnose"}).json()


def _add_model_provider(client):
    client.post("/model-providers", json={
        "name": "openai", "provider_type": "openai", "base_url": "https://api.openai.com/v1",
        "model": "gpt-4o-mini", "api_key": MODEL_KEY})


def _wait_settled(client, task_id, exec_id, timeout=10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        row = client.get(f"/agent-tasks/{task_id}/executions/{exec_id}").json()
        if row["status"] not in ("queued", "running"):
            return row
        time.sleep(0.05)
    raise AssertionError("execution never settled")


# --- runtime split -------------------------------------------------------------


def test_runtime_is_split_by_responsibility_and_facade_reexports():
    from app.agent_runtime import finalize, guards, limits, prompt, steer, stream, usage
    assert session_agent.stream_events_for is stream.stream_events_for
    assert session_agent.SteerQueue is steer.SteerQueue
    assert session_agent.INSTRUCTIONS is prompt.INSTRUCTIONS
    assert session_agent._finalize_directive is finalize._finalize_directive
    assert session_agent._usage_snapshot is usage._usage_snapshot
    assert session_agent._install_tool_gating is guards._install_tool_gating
    assert session_agent._MAX_TURNS == limits._MAX_TURNS
    # The metadata contract is gone: no JSON block is asked for or parsed.
    assert "```json" not in prompt.INSTRUCTIONS
    assert "next_action_proposals" not in prompt.INSTRUCTIONS
    assert "import_evidence" in prompt.INSTRUCTIONS or "import_evidence" in session_agent.tool_group_catalog()
    import importlib
    import pytest
    with pytest.raises(ModuleNotFoundError):
        importlib.import_module("app.skills.contract")


# --- per-segment streaming -----------------------------------------------------


class _Delta:
    def __init__(self, text):
        self.delta = text


def _text_event(text):
    from openai.types.responses import ResponseTextDeltaEvent
    ev = type("E", (), {})()
    ev.type = "raw_response_event"
    ev.data = ResponseTextDeltaEvent(content_index=0, delta=text, item_id="i", output_index=0,
                                     sequence_number=0, type="response.output_text.delta",
                                     logprobs=[])
    return ev


def _item_event(name):
    ev = type("E", (), {})()
    ev.type = "run_item_stream_event"
    ev.name = name
    return ev


def test_stream_closes_commentary_segments_at_message_boundaries_and_ends_with_answer():
    activity: list[dict] = []

    class FakeResult:
        final_output = "Bucket acme is reachable and has 3 keys."

        async def stream_events(self):
            yield _text_event("Checking the bucket ")
            yield _text_event("first.")
            yield _item_event("message_output_created")
            yield _item_event("tool_called")
            activity.append({"id": "t1", "tool": "head_bucket", "target": "acme", "status": "started"})
            yield _item_event("tool_output")
            activity.append({"id": "t1", "tool": "head_bucket", "target": "acme",
                             "result": "200", "ok": True, "status": "completed"})
            yield _text_event("Bucket acme is reachable and has 3 keys.")
            yield _item_event("message_output_created")

    async def collect():
        out = []
        async for kind, data in session_agent.stream_events_for(FakeResult(), activity, []):
            out.append((kind, data))
        return out

    events = asyncio.run(collect())
    kinds = [k for k, _ in events]
    segments = [d for k, d in events if k == "segment"]
    assert segments[0] == {"text": "Checking the bucket first.", "final": False}
    assert segments[-1]["final"] is True
    assert segments[-1]["text"] == "Bucket acme is reachable and has 3 keys."
    # The commentary segment closes BEFORE the tool rows that follow it.
    assert kinds.index("segment") < kinds.index("tool")
    final = events[-1][1]
    assert events[-1][0] == "final"
    assert final["answer"] == "Bucket acme is reachable and has 3 keys."
    assert final["turn_items"] == [
        {"kind": "message", "text": "Checking the bucket first."},
        {"kind": "tool", "id": "t1", "tool": "head_bucket"},
    ]
    assert "next_action_proposals" not in final


def test_stream_sanitizes_each_segment_and_stop_keeps_partial_text():
    cancel = threading.Event()

    class FakeResult:
        final_output = ""

        async def stream_events(self):
            yield _text_event("<think>hidden</think>Looking at the policy now. " + "x" * 200)
            cancel.set()
            yield _text_event("more")

        def cancel(self):
            pass

    async def collect():
        out = []
        async for kind, data in session_agent.stream_events_for(
                FakeResult(), [], [], cancel_event=cancel):
            out.append((kind, data))
        return out

    events = asyncio.run(collect())
    final = events[-1][1]
    assert final["stopped"] is True
    assert "hidden" not in final["answer"]
    assert "Looking at the policy now." in final["answer"]
    assert session_agent._STOPPED_MARKER in final["answer"]
    for k, d in events:
        if k == "delta":
            assert "hidden" not in d


# --- durable turn items ----------------------------------------------------------


def test_turn_items_persist_on_the_assistant_message(client, monkeypatch):
    task = _task(client)
    _add_model_provider(client)

    def fake_loop(spec):
        spec["activity"].append({"id": "c1", "tool": "list_buckets", "target": "p1",
                                 "result": "2 buckets", "ok": True, "status": "completed"})
        return {"answer": "Two buckets.", "skills_used": [], "skills_offered": [],
                "evidence_used": [], "evidence_gaps": [],
                "tool_activity": list(spec["activity"]),
                "turn_items": [{"kind": "message", "text": "Listing buckets first."},
                               {"kind": "tool", "id": "c1", "tool": "list_buckets"},
                               {"kind": "bogus"}]}

    monkeypatch.setattr(session_agent, "SESSION_LOOP", fake_loop)
    r = client.post(f"/agent-tasks/{task['id']}/executions", json={"direction": "what buckets?"})
    exec_id = r.json()["execution"]["id"]
    assert _wait_settled(client, task["id"], exec_id)["status"] == "completed"
    msgs = client.get(f"/sessions/{task['id']}").json()["messages"]
    assistant = [m for m in msgs if m["role"] == "assistant"][-1]
    assert assistant["content"] == "Two buckets."
    assert assistant["turn_items"] == [{"kind": "message", "text": "Listing buckets first."},
                                       {"kind": "tool", "id": "c1"}]
    assert "proposed_actions" not in assistant
    # Nothing is ever pending: the task is simply ready again.
    state = client.get(f"/agent-tasks/{task['id']}/state").json()
    assert "pending_decisions" not in state
    assert state["status"] == "ready"


def test_migration_029_adds_turn_items_and_decision_kind_scope(client):
    from app.db import connect
    conn = connect()
    try:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(session_messages)")}
        assert "turn_items" in cols
        dcols = {r[1] for r in conn.execute("PRAGMA table_info(task_decisions)")}
        assert {"kind", "scope"} <= dcols
    finally:
        conn.close()


# --- the one data-moving tool (v2.1: bounded, no approval pause) ---------------


def test_import_evidence_tool_is_registered_bounded_and_untimed(client):
    from app.agent_runtime import guards, import_tools, limits
    from app.db import connect
    from agents import function_tool
    task = _task(client)
    conn = connect()
    try:
        tools = import_tools.build(conn, function_tool, [], task["id"], "turn-x")
    finally:
        conn.close()
    assert [t.name for t in tools] == ["import_evidence"]
    assert limits._GROUP_OF_TOOL["import_evidence"] == "evidence_import"
    assert "import_evidence" in limits._NO_TIMEOUT_TOOLS
    assert guards._install_tool_timeouts(tools) == 0


# --- live stream ordering ----------------------------------------------------------


def test_live_stream_interleaves_deltas_and_durable_events_in_worker_order(client):
    """The hub records where in the delta stream each durable event landed, so
    a subscriber never sees a tool row after text the model wrote once the
    tool had returned, nor a segment's tail after the event that closed it."""
    import asyncio

    from app.db import connect
    from app.task_runtime import event_stream, hub, store

    task = _task(client)
    conn = connect()
    try:
        store.ensure_task(conn, task["id"])
        execution = store.create_execution(conn, task["id"], "order", "r-order")
        store.set_execution_status(conn, execution["id"], store.EXEC_RUNNING)
        conn.commit()
        exec_id = execution["id"]
        hub.open_live(exec_id)
        hub.push_delta(exec_id, "Checking ")
        store.append_event(conn, exec_id, task["id"], "tool.started", {"id": "t1", "tool": "head_bucket"})
        store.append_event(conn, exec_id, task["id"], "tool.completed", {"id": "t1", "tool": "head_bucket"})
        hub.push_delta(exec_id, "Done.")
        store.append_event(conn, exec_id, task["id"], "message.completed", {"text": "Done.", "final": True})
        store.set_execution_status(conn, exec_id, store.EXEC_COMPLETED)
        conn.commit()
        hub.mark_done(exec_id)
    finally:
        conn.close()

    async def collect():
        out = []
        # Attach with an empty live buffer view (delta_cursor 0 → include everything).
        async for frame in event_stream.execution_frames(exec_id, 0, include_deltas=True):
            out.append(frame)
        return out

    # The first attach skips what streamed before it; simulate a subscriber
    # that was there from the start by reading from offset 0 directly.
    parts, _, _ = hub.ordered_snapshot(exec_id, 0)
    kinds = [(k, v if k == "text" else "mark") for k, v in parts]
    assert kinds == [("text", "Checking "), ("mark", "mark"), ("mark", "mark"),
                     ("text", "Done."), ("mark", "mark")]
    frames = asyncio.run(collect())
    types = [line.split(": ", 1)[1] for f in frames for line in f.splitlines() if line.startswith("event: ")]
    assert types[-2:] == ["message.completed", "end"] or types[-1] == "end"


# --- v1.12: push transport -------------------------------------------------------


def test_follower_wakes_on_hub_events_without_polling(client, monkeypatch):
    """The SSE follower sleeps on the hub's wakeup and reads SQLite only when
    something happened: over a quiet second on a live execution it issues no
    event query at all, and a delta pushed from another thread reaches it
    without waiting for any poll interval."""
    import asyncio
    from app.db import connect
    from app.task_runtime import event_stream, hub, store

    task = _task(client)
    conn = connect()
    try:
        store.ensure_task(conn, task["id"])
        execution = store.create_execution(conn, task["id"], "quiet", "w2")
        store.set_execution_status(conn, execution["id"], store.EXEC_RUNNING)
        conn.commit()
    finally:
        conn.close()
    hub.open_live(execution["id"])
    reads = {"n": 0}
    real_list = store.list_events

    def counting_list(*a, **k):
        reads["n"] += 1
        return real_list(*a, **k)

    monkeypatch.setattr(event_stream.store, "list_events", counting_list)

    async def drive():
        frames = []
        gen = event_stream.execution_frames(execution["id"], after_seq=0)
        # Quiet second: nothing arrives, nothing is read after the first drain.
        task_ = asyncio.ensure_future(gen.__anext__())
        await asyncio.sleep(1.0)
        baseline = reads["n"]
        assert not task_.done()
        # A delta from the worker thread wakes the follower promptly.
        t0 = asyncio.get_running_loop().time()
        await asyncio.get_running_loop().run_in_executor(
            None, hub.push_delta, execution["id"], "hello")
        frame = await asyncio.wait_for(task_, 1.0)
        assert "hello" in frame and asyncio.get_running_loop().time() - t0 < 0.5
        frames.append(frame)
        hub.mark_done(execution["id"])
        conn2 = connect()
        try:
            store.set_execution_status(conn2, execution["id"], store.EXEC_COMPLETED)
            conn2.commit()
        finally:
            conn2.close()
        async for f in gen:
            frames.append(f)
        return baseline, frames

    baseline, frames = asyncio.run(drive())
    # The first drain reads once; the quiet second reads nothing more.
    assert baseline <= 2, baseline
    assert frames[-1].startswith("event: end")


def test_task_status_rides_the_execution_stream(client, monkeypatch):
    """Queued Directions and pending approvals reach a follower as
    `task.status` events, so it never polls /state while attached."""
    task = _task(client)
    _add_model_provider(client)
    release = threading.Event()

    def slow_loop(spec):
        release.wait(5.0)
        return {"answer": "done", "skills_used": [], "skills_offered": [], "evidence_used": [],
                "evidence_gaps": [], "tool_activity": []}

    monkeypatch.setattr(session_agent, "SESSION_LOOP", slow_loop)
    first = client.post(f"/agent-tasks/{task['id']}/executions",
                        json={"direction": "one"}).json()["execution"]
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and client.get(
            f"/agent-tasks/{task['id']}/executions/{first['id']}").json()["status"] != "running":
        time.sleep(0.02)
    second = client.post(f"/agent-tasks/{task['id']}/executions",
                         json={"direction": "two"}).json()["execution"]
    release.set()
    _wait_settled(client, task["id"], first["id"])
    _wait_settled(client, task["id"], second["id"])
    rows = client.get(f"/agent-tasks/{task['id']}/events?after=0&limit=1000").json()["events"]
    statuses = [e for e in rows if e["event_type"] == "task.status"]
    assert statuses, [e["event_type"] for e in rows]
    # While the first ran, a status event on ITS log listed the second as queued.
    seen_queued = [e for e in statuses if e["execution_id"] == first["id"]
                   and any(q["id"] == second["id"] for q in e["payload"]["queued"])]
    assert seen_queued
    assert statuses[-1]["payload"]["status"] == "ready"
    assert statuses[-1]["payload"]["queued"] == []


# --- v2.1: the model keeps no plan -------------------------------------------------


def test_there_is_no_plan_tool_event_or_turn_item():
    import importlib

    import pytest

    from app.agent_runtime import limits, prompt
    from app.agent_runtime.stream import _Segments
    assert "update_plan" not in limits._CORE_TOOLS
    assert "update_plan" not in prompt.INSTRUCTIONS
    with pytest.raises(ModuleNotFoundError):
        importlib.import_module("app.agent_runtime.plan_tools")
    seg = _Segments()
    seg.tool({"id": "p1", "tool": "update_plan", "status": "completed",
              "plan": [{"text": "A", "status": "in_progress"}]})
    assert not any(it.get("kind") == "plan" for it in seg.items)


def test_a_stored_pre_2_1_plan_item_is_dropped_on_read(client):
    from app.db import connect
    task = _task(client)
    conn = connect()
    try:
        conn.execute(
            "INSERT INTO session_messages (id, session_id, role, content, turn_items, created_at) "
            "VALUES ('m-old', ?, 'assistant', 'Done.', ?, datetime('now'))",
            (task["id"], '[{"kind": "plan", "steps": [{"text": "A", "status": "completed"}]},'
                         ' {"kind": "message", "text": "Checked."}]'))
        conn.commit()
    finally:
        conn.close()
    msg = [m for m in client.get(f"/sessions/{task['id']}").json()["messages"]
           if m["id"] == "m-old"][0]
    assert msg["turn_items"] == [{"kind": "message", "text": "Checked."}]
