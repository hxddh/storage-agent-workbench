"""v1.11.0 — Codex-style turns: per-segment streaming, durable turn items,
Decisions raised inline by a gated tool, and the runtime split.

Take the UI away: the runtime alone must produce a transcript of commentary
segments and tool rows before the answer, persist it, and pause an execution
for an approval that only the user can grant.
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
    # No proposal-derived Decision exists any more.
    state = client.get(f"/agent-tasks/{task['id']}/state").json()
    assert state["pending_decisions"] == []
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


# --- inline approvals ------------------------------------------------------------


def _approval_execution(client, task_id):
    """A running execution with a live handle, as the worker would have."""
    from app.db import connect
    from app.task_runtime import runtime, store
    conn = connect()
    try:
        store.ensure_task(conn, task_id)
        execution = store.create_execution(conn, task_id, "import the inventory", "r-approval")
        store.set_execution_status(conn, execution["id"], store.EXEC_RUNNING)
        conn.commit()
    finally:
        conn.close()
    handle = runtime.LiveExecution(execution["id"], task_id)
    with runtime._lock:
        runtime._live[execution["id"]] = handle
    return execution, handle


def _proposal():
    return {"tool": "import_evidence", "import_id": "imp1",
            "args": {"source_type": "inventory", "bucket_name": "acme-inv"},
            "impact": {"gate": "cloud_download", "bucket": "acme-inv", "prefix": "inv/",
                       "file_count": 3, "total_bytes": 4096, "source_type": "inventory",
                       "why": "Moves bytes onto this machine."}}


def test_gated_tool_pauses_execution_until_the_user_allows(client):
    from app.db import connect
    from app.task_runtime import runtime, store
    task = _task(client)
    execution, handle = _approval_execution(client, task["id"])
    result: dict = {}

    def tool_thread():
        conn = connect()
        try:
            result["decision"] = runtime.request_approval(
                conn, execution["id"], task["id"], action_type="import_inventory",
                title="Import 3 inventory files from acme-inv", reason="bounded download",
                proposal=_proposal(), cancel_event=handle.cancel_event)
        finally:
            conn.close()

    t = threading.Thread(target=tool_thread, daemon=True)
    t.start()
    # The execution is waiting and the Decision is visible with its impact.
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        state = client.get(f"/agent-tasks/{task['id']}/state").json()
        if state["pending_decisions"]:
            break
        time.sleep(0.05)
    assert state["status"] == "needs_decision"
    pending = state["pending_decisions"][0]
    assert pending["kind"] == "approval"
    assert pending["impact"]["file_count"] == 3
    assert pending["impact"]["bucket"] == "acme-inv"
    assert client.get(f"/agent-tasks/{task['id']}/executions/{execution['id']}"
                      ).json()["status"] == "waiting"
    events = client.get(f"/agent-tasks/{task['id']}/events").json()["events"]
    assert any(e["event_type"] == "approval.opened" and e["payload"]["decision_id"] == pending["id"]
               for e in events)

    r = client.post(f"/agent-tasks/{task['id']}/decisions/{pending['id']}/resolve",
                    json={"resolution": "approved", "scope": "task"})
    assert r.status_code == 200
    assert r.json()["decision"]["scope"] == "task"
    assert r.json()["prepared"] is None
    t.join(5)
    assert not t.is_alive()
    assert result["decision"]["status"] == "approved"
    # The SAME execution is running again — no second execution, no settle.
    row = client.get(f"/agent-tasks/{task['id']}/executions/{execution['id']}").json()
    assert row["status"] == "running"

    # "Allow for this task": the next request of the same type does not pause.
    conn = connect()
    try:
        t0 = time.monotonic()
        granted = runtime.request_approval(
            conn, execution["id"], task["id"], action_type="import_inventory",
            title="Import again", reason=None, proposal=_proposal(),
            cancel_event=handle.cancel_event)
        assert time.monotonic() - t0 < 1.0
        assert granted["status"] == "approved" and granted["scope"] == "task"
        assert store.get_execution(conn, execution["id"])["status"] == "running"
    finally:
        conn.close()
    events = client.get(f"/agent-tasks/{task['id']}/events").json()["events"]
    assert any(e["event_type"] == "approval.granted" for e in events)
    with runtime._lock:
        runtime._live.pop(execution["id"], None)


def test_deny_and_stop_never_approve(client):
    from app.db import connect
    from app.task_runtime import runtime
    task = _task(client)
    execution, handle = _approval_execution(client, task["id"])
    out: list = []

    def tool_thread():
        conn = connect()
        try:
            out.append(runtime.request_approval(
                conn, execution["id"], task["id"], action_type="import_access_log",
                title="Import logs", reason=None, proposal=_proposal(),
                cancel_event=handle.cancel_event))
        finally:
            conn.close()

    t = threading.Thread(target=tool_thread, daemon=True)
    t.start()
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        pending = client.get(f"/agent-tasks/{task['id']}/decisions?status_filter=pending"
                             ).json()["decisions"]
        if pending:
            break
        time.sleep(0.05)
    client.post(f"/agent-tasks/{task['id']}/decisions/{pending[0]['id']}/resolve",
                json={"resolution": "declined"})
    t.join(5)
    assert out[0]["status"] == "declined" and out[0]["scope"] is None

    # Stop while waiting withdraws the request as declined.
    out.clear()
    t = threading.Thread(target=tool_thread, daemon=True)
    t.start()
    time.sleep(0.3)
    handle.cancel_event.set()
    t.join(5)
    assert out and out[0]["status"] == "declined"
    assert "stopped" in (out[0]["resolution_note"] or "")
    with runtime._lock:
        runtime._live.pop(execution["id"], None)


def test_import_evidence_tool_is_registered_gated_and_untimed(client):
    from app.agent_runtime import gated_tools, guards, limits
    from app.db import connect
    from agents import function_tool
    task = _task(client)
    conn = connect()
    try:
        tools = gated_tools.build(conn, function_tool, [], task["id"], "turn-x")
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


# --- v1.12: the plan the model owns -------------------------------------------------


def test_update_plan_is_a_bounded_core_tool_that_becomes_one_plan_item(client, monkeypatch):
    from agents import function_tool
    from app.agent_runtime import limits, plan_tools

    assert "update_plan" in limits._CORE_TOOLS
    activity: list = []
    assert plan_tools.build(function_tool, activity)[0].name == "update_plan"
    steps = [{"text": "Survey the account", "status": "completed"},
             {"text": "Check acme-logs policy <think>secret</think>", "status": "in_progress"},
             {"text": "x" * 500, "status": "bogus"}] + [{"text": f"s{i}", "status": "pending"} for i in range(20)]
    norm = plan_tools.normalize_steps(steps)
    assert len(norm) == plan_tools.MAX_STEPS
    assert norm[1] == {"text": "Check acme-logs policy", "status": "in_progress"}
    assert len(norm[2]["text"]) == plan_tools.MAX_STEP_CHARS and norm[2]["status"] == "pending"

    # Through the runtime: two calls → ONE plan item at the first call's
    # position, updated in place; a `plan.updated` event per call; the plan is
    # not a tool row of the Work Result.
    task = _task(client)
    _add_model_provider(client)

    def fake_loop(spec):
        spec["activity"].append({"id": "p1", "tool": "update_plan", "target": "2 steps",
                                 "result": "0/2 done", "ok": True, "status": "completed",
                                 "plan": [{"text": "A", "status": "in_progress"}, {"text": "B", "status": "pending"}]})
        spec["activity"].append({"id": "c1", "tool": "head_bucket", "target": "acme",
                                 "result": "200", "ok": True, "status": "completed"})
        spec["activity"].append({"id": "p2", "tool": "update_plan", "target": "2 steps",
                                 "result": "2/2 done", "ok": True, "status": "completed",
                                 "plan": [{"text": "A", "status": "completed"}, {"text": "B", "status": "completed"}]})
        return {"answer": "Done.", "skills_used": [], "skills_offered": [], "evidence_used": [],
                "evidence_gaps": [],
                "tool_activity": [a for a in spec["activity"] if a["tool"] != "update_plan"],
                "plan_updates": [a["plan"] for a in spec["activity"] if a["tool"] == "update_plan"],
                "turn_items": [{"kind": "plan", "steps": [{"text": "A", "status": "completed"},
                                                          {"text": "B", "status": "completed"}]},
                               {"kind": "tool", "id": "c1", "tool": "head_bucket"}]}

    monkeypatch.setattr(session_agent, "SESSION_LOOP", fake_loop)
    ex = client.post(f"/agent-tasks/{task['id']}/executions", json={"direction": "plan it"}).json()["execution"]
    assert _wait_settled(client, task["id"], ex["id"])["status"] == "completed"
    msg = [m for m in client.get(f"/sessions/{task['id']}").json()["messages"] if m["role"] == "assistant"][-1]
    assert msg["turn_items"][0] == {"kind": "plan", "steps": [{"text": "A", "status": "completed"},
                                                              {"text": "B", "status": "completed"}]}
    assert [a["tool"] for a in msg["tool_activity"]] == ["head_bucket"]
    events = client.get(f"/agent-tasks/{task['id']}/events?after=0&limit=1000").json()["events"]
    plans = [e["payload"]["steps"] for e in events if e["event_type"] == "plan.updated"]
    assert len(plans) == 2 and plans[-1][0]["status"] == "completed"


def test_stream_folds_update_plan_calls_into_one_plan_item():
    from app.agent_runtime.stream import _Segments
    seg = _Segments()
    seg.tool({"id": "p1", "tool": "update_plan", "status": "completed", "plan": [{"text": "A", "status": "in_progress"}]})
    seg.tool({"id": "t1", "tool": "head_bucket", "status": "completed"})
    seg.tool({"id": "p2", "tool": "update_plan", "status": "completed", "plan": [{"text": "A", "status": "completed"}]})
    assert seg.items == [{"kind": "plan", "steps": [{"text": "A", "status": "completed"}]},
                         {"kind": "tool", "id": "t1", "tool": "head_bucket"}]
