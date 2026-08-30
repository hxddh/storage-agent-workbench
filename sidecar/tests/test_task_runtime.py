"""Durable Agent Task runtime tests (v0.94).

Take the UI away: these tests assert that the runtime + persistence alone are a
real task runtime — durable executions with a lifecycle, structured durable
progress events, steer acting on the current execution, first-class Decisions
(including the WAITING execution state they gate), restart recovery with
explicit interrupted/resume semantics, first-class Artifacts and Work Results,
and a typed versioned Storage Task Context.
"""

from __future__ import annotations

import threading
import time

import pytest

from app.agent_runtime import session_agent

MODEL_KEY = "sk-TESTKEY-DONOTLEAK-0001"


def _task(client, title="Diagnose slow reads"):
    return client.post("/sessions", json={"title": title, "goal": "diagnose"}).json()


def _add_model_provider(client):
    client.post("/model-providers", json={
        "name": "openai", "provider_type": "openai", "base_url": "https://api.openai.com/v1",
        "model": "gpt-4o-mini", "api_key": MODEL_KEY})


def _contract(answer="All buckets are healthy.", proposals=None, activity=None):
    return {
        "answer": answer,
        "skills_used": [], "skills_offered": [], "evidence_used": [],
        "evidence_gaps": [], "next_action_proposals": proposals or [],
        "tool_activity": activity or [],
    }


def _gated_proposal():
    return {"action_type": "plan_access_log_import", "title": "Import access logs",
            "reason": "Bounded evidence download.", "requires_confirmation": True,
            "confidence": "high", "source_run_ids": [], "prefill": {},
            "id": "proposal_x", "required_inputs": [], "safety_notes": [],
            "status": "proposed"}


def _wait_settled(client, task_id, exec_id, timeout=10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        row = client.get(f"/agent-tasks/{task_id}/executions/{exec_id}").json()
        if row["status"] not in ("queued", "running"):
            return row
        time.sleep(0.05)
    raise AssertionError("execution never settled")


# --- lifecycle -----------------------------------------------------------------


def test_execution_lifecycle_is_durable_and_structured(client, monkeypatch):
    task = _task(client)
    _add_model_provider(client)
    monkeypatch.setattr(session_agent, "SESSION_LOOP", lambda spec: _contract(
        activity=[{"tool": "head_bucket", "target": "acme-logs", "result": "200",
                   "ok": True, "status": "completed"}]))

    r = client.post(f"/agent-tasks/{task['id']}/executions",
                    json={"direction": "check acme-logs", "turn_id": "t1"})
    assert r.status_code == 201 and r.json()["created"] is True
    exec_id = r.json()["execution"]["id"]

    row = _wait_settled(client, task["id"], exec_id)
    assert row["status"] == "completed"
    assert row["work_result_id"]
    assert row["started_at"] and row["finished_at"]

    # Structured durable progress — status transitions, tool activity, and the
    # Work Result — all in the append-only event log, never inferred from prose.
    events = client.get(f"/agent-tasks/{task['id']}/executions/{exec_id}/events",
                        params={"deltas": "false"})
    kinds = [line.split("event: ", 1)[1].strip()
             for line in events.text.splitlines() if line.startswith("event: ")]
    assert kinds[0] == "execution.status"            # queued
    assert "tool.completed" in kinds
    assert "work_result.recorded" in kinds
    assert kinds[-1] == "end"

    # The Work Result is a durable object with the runtime metadata.
    wrs = client.get(f"/agent-tasks/{task['id']}/work-results").json()["work_results"]
    assert wrs and wrs[-1]["execution_id"] == exec_id
    assert wrs[-1]["message_id"]

    # The task's durable status went back to ready.
    state = client.get(f"/agent-tasks/{task['id']}/state").json()
    assert state["status"] == "ready"
    assert state["active_execution"] is None


def test_duplicate_turn_id_attaches_instead_of_rerunning(client, monkeypatch):
    task = _task(client)
    _add_model_provider(client)
    calls = []

    def loop(spec):
        calls.append(spec["session_id"])
        return _contract()

    monkeypatch.setattr(session_agent, "SESSION_LOOP", loop)
    first = client.post(f"/agent-tasks/{task['id']}/executions",
                        json={"direction": "check", "turn_id": "dup"}).json()
    _wait_settled(client, task["id"], first["execution"]["id"])
    second = client.post(f"/agent-tasks/{task['id']}/executions",
                         json={"direction": "check", "turn_id": "dup"}).json()
    assert second["created"] is False
    assert second["execution"]["id"] == first["execution"]["id"]
    assert len(calls) == 1


def test_submissions_while_working_queue_durably(client, monkeypatch):
    """A second Direction while one executes is queued as its own durable
    execution and runs after — never a concurrent re-run, never a cancel."""
    task = _task(client)
    _add_model_provider(client)
    release = threading.Event()
    order = []

    def loop(spec):
        order.append(spec["prompt"][-20:])
        release.wait(5.0)
        return _contract()

    monkeypatch.setattr(session_agent, "SESSION_LOOP", loop)
    a = client.post(f"/agent-tasks/{task['id']}/executions",
                    json={"direction": "first", "turn_id": "q1"}).json()["execution"]
    b = client.post(f"/agent-tasks/{task['id']}/executions",
                    json={"direction": "second", "turn_id": "q2"}).json()["execution"]
    # While the first runs, the second is durably queued.
    time.sleep(0.3)
    assert client.get(f"/agent-tasks/{task['id']}/executions/{b['id']}").json()["status"] == "queued"
    release.set()
    assert _wait_settled(client, task["id"], a["id"])["status"] == "completed"
    assert _wait_settled(client, task["id"], b["id"])["status"] == "completed"
    msgs = client.get(f"/sessions/{task['id']}/messages").json()["messages"]
    assert [m["content"] for m in msgs if m["role"] == "user"] == ["first", "second"]


# --- steer ----------------------------------------------------------------------


def test_steer_reaches_the_current_execution(client, monkeypatch):
    """Steer acts ON the running execution: the text lands in its steer queue
    and the durable log records steer.received — no cancel, no new turn."""
    task = _task(client)
    _add_model_provider(client)
    started = threading.Event()
    release = threading.Event()
    seen = {}

    def loop(spec):
        started.set()
        release.wait(5.0)
        queue = spec.get("cancel_event")  # legacy loop has no steer visibility
        seen["cancelled"] = bool(queue and queue.is_set())
        return _contract("answer after steer")

    monkeypatch.setattr(session_agent, "SESSION_LOOP", loop)
    execution = client.post(f"/agent-tasks/{task['id']}/executions",
                            json={"direction": "go", "turn_id": "s1"}).json()["execution"]
    assert started.wait(5.0)
    r = client.post(f"/agent-tasks/{task['id']}/steer", json={"text": "focus on us-east-1"})
    assert r.status_code == 200 and r.json()["status"] == "steering"
    release.set()
    row = _wait_settled(client, task["id"], execution["id"])
    # Steer never cancelled the execution.
    assert seen["cancelled"] is False
    assert row["steer_count"] == 1
    events = client.get(f"/agent-tasks/{task['id']}/events").json()["events"]
    assert any(e["event_type"] == "steer.received" for e in events)
    # An undelivered steer (the loop never hit a tool boundary) is carried into
    # an automatic follow-up execution, so the direction is never dropped.
    followups = [e for e in client.get(f"/agent-tasks/{task['id']}/executions").json()["executions"]
                 if e["kind"] == "steer_followup"]
    assert len(followups) == 1
    assert "us-east-1" in followups[0]["direction"]


def test_steer_with_nothing_active_is_409(client):
    task = _task(client)
    r = client.post(f"/agent-tasks/{task['id']}/steer", json={"text": "hello"})
    assert r.status_code == 409


def test_steer_queue_injects_at_tool_boundary():
    """Unit: the steer text is delivered THROUGH the running loop's next tool
    return, outside the untrusted envelope, and recorded in the activity."""
    import asyncio

    class Tool:
        name = "head_bucket"

        async def on_invoke_tool(self, ctx, args):
            return "ok"

    q = session_agent.SteerQueue()
    activity: list = []
    tool = Tool()
    session_agent._install_steer_injection([tool], q, activity)
    q.push("check versioning instead")
    out = asyncio.run(tool.on_invoke_tool(None, "{}"))
    assert "USER STEER" in out and "check versioning instead" in out
    assert q.delivered == ["check versioning instead"]
    assert [a["tool"] for a in activity] == ["user_steer"]
    # Drained: the next call carries no stale steer.
    out2 = asyncio.run(tool.on_invoke_tool(None, "{}"))
    assert "USER STEER" not in out2


# --- stop -----------------------------------------------------------------------


def test_stop_running_execution_cancels_durably(client, monkeypatch):
    task = _task(client)
    _add_model_provider(client)
    started = threading.Event()

    def loop(spec):
        started.set()
        cancel = spec.get("cancel_event")
        for _ in range(100):
            if cancel is not None and cancel.is_set():
                break
            time.sleep(0.05)
        return {**_contract("partial answer"), "stopped": True}

    monkeypatch.setattr(session_agent, "SESSION_LOOP", loop)
    execution = client.post(f"/agent-tasks/{task['id']}/executions",
                            json={"direction": "go", "turn_id": "stop1"}).json()["execution"]
    assert started.wait(5.0)
    r = client.post(f"/agent-tasks/{task['id']}/executions/{execution['id']}/stop")
    assert r.status_code == 200
    row = _wait_settled(client, task["id"], execution["id"])
    assert row["status"] == "cancelled"
    # The partial Work Result persisted with the stopped flag.
    wrs = client.get(f"/agent-tasks/{task['id']}/work-results").json()["work_results"]
    assert wrs[-1]["stopped"] is True


# --- decisions gate executions ----------------------------------------------------


def test_gated_proposal_leaves_execution_waiting_until_decision(client, monkeypatch):
    task = _task(client)
    _add_model_provider(client)
    monkeypatch.setattr(session_agent, "SESSION_LOOP",
                        lambda spec: _contract(proposals=[_gated_proposal()]))
    execution = client.post(f"/agent-tasks/{task['id']}/executions",
                            json={"direction": "import the logs", "turn_id": "d1"}
                            ).json()["execution"]
    row = _wait_settled(client, task["id"], execution["id"])
    # The model work is done but the confirmation boundary is not crossed:
    # the execution WAITS on the durable Decision.
    assert row["status"] == "waiting"
    state = client.get(f"/agent-tasks/{task['id']}/state").json()
    assert state["status"] == "needs_decision"
    decisions = state["pending_decisions"]
    assert len(decisions) == 1 and decisions[0]["execution_id"] == execution["id"]

    r = client.post(f"/agent-tasks/{task['id']}/decisions/{decisions[0]['id']}/resolve",
                    json={"resolution": "declined", "note": "not now"})
    assert r.status_code == 200
    row = client.get(f"/agent-tasks/{task['id']}/executions/{execution['id']}").json()
    assert row["status"] == "completed"
    assert client.get(f"/agent-tasks/{task['id']}/state").json()["status"] == "ready"
    events = client.get(f"/agent-tasks/{task['id']}/events").json()["events"]
    kinds = [e["event_type"] for e in events]
    assert "decision.opened" in kinds and "decision.resolved" in kinds


# --- recovery ------------------------------------------------------------------


def test_restart_recovery_marks_interrupted_and_resume_continues(client, monkeypatch):
    from app.db import connect
    from app.task_runtime import recovery, store

    task = _task(client)
    _add_model_provider(client)
    conn = connect()
    try:
        store.ensure_task(conn, task["id"])
        execution = store.create_execution(conn, task["id"], "long survey", "r1")
        store.set_execution_status(conn, execution["id"], store.EXEC_RUNNING)
        store.set_task_status(conn, task["id"], store.TASK_WORKING,
                              active_execution_id=execution["id"])
        conn.commit()
    finally:
        conn.close()

    assert recovery.reconcile_interrupted_executions() == 1

    row = client.get(f"/agent-tasks/{task['id']}/executions/{execution['id']}").json()
    assert row["status"] == "interrupted"
    assert "restart" in (row["error"] or "")
    state = client.get(f"/agent-tasks/{task['id']}/state").json()
    assert state["status"] == "needs_attention"
    events = client.get(f"/agent-tasks/{task['id']}/events").json()["events"]
    assert any(e["event_type"] == "execution.status"
               and e["payload"].get("reason") == "sidecar_restart" for e in events)

    # Resume: a NEW execution carrying the direction; history is not rewritten.
    monkeypatch.setattr(session_agent, "SESSION_LOOP", lambda spec: _contract())
    r = client.post(f"/agent-tasks/{task['id']}/executions/{execution['id']}/resume")
    assert r.status_code == 201
    resumed = r.json()["execution"]
    assert resumed["resumed_from"] == execution["id"]
    assert "long survey" in resumed["direction"]
    assert _wait_settled(client, task["id"], resumed["id"])["status"] == "completed"
    assert client.get(f"/agent-tasks/{task['id']}/executions/{execution['id']}"
                      ).json()["status"] == "interrupted"


def test_resume_of_a_live_execution_is_409(client, monkeypatch):
    task = _task(client)
    _add_model_provider(client)
    release = threading.Event()
    monkeypatch.setattr(session_agent, "SESSION_LOOP",
                        lambda spec: (release.wait(5.0), _contract())[1])
    execution = client.post(f"/agent-tasks/{task['id']}/executions",
                            json={"direction": "go", "turn_id": "rl1"}).json()["execution"]
    r = client.post(f"/agent-tasks/{task['id']}/executions/{execution['id']}/resume")
    assert r.status_code == 409
    release.set()
    _wait_settled(client, task["id"], execution["id"])


# --- durable stream resume ---------------------------------------------------------


def test_event_stream_replays_from_any_sequence(client, monkeypatch):
    task = _task(client)
    _add_model_provider(client)
    monkeypatch.setattr(session_agent, "SESSION_LOOP", lambda spec: _contract())
    execution = client.post(f"/agent-tasks/{task['id']}/executions",
                            json={"direction": "go", "turn_id": "seq1"}).json()["execution"]
    _wait_settled(client, task["id"], execution["id"])

    full = client.get(f"/agent-tasks/{task['id']}/executions/{execution['id']}/events",
                      params={"deltas": "false"}).text
    ids = [int(line.split("id: ", 1)[1]) for line in full.splitlines()
           if line.startswith("id: ")]
    assert ids == sorted(ids) and len(ids) >= 3

    # Resume from the middle: only later events replay (durable cursor).
    mid = ids[len(ids) // 2]
    partial = client.get(f"/agent-tasks/{task['id']}/executions/{execution['id']}/events",
                         params={"deltas": "false", "after": mid}).text
    partial_ids = [int(line.split("id: ", 1)[1]) for line in partial.splitlines()
                   if line.startswith("id: ")]
    assert partial_ids == [i for i in ids if i > mid]


# --- artifacts + typed context --------------------------------------------------------


def test_report_is_indexed_as_first_class_artifact(client):
    task = _task(client)
    assert client.get(f"/sessions/{task['id']}/report").status_code == 200
    arts = client.get(f"/agent-tasks/{task['id']}/artifacts").json()["artifacts"]
    assert len(arts) == 1
    assert arts[0]["artifact_type"] == "report"
    assert arts[0]["ref_kind"] == "session_report"
    # Re-rendering the same report does not stack duplicate artifacts.
    client.get(f"/sessions/{task['id']}/report")
    arts = client.get(f"/agent-tasks/{task['id']}/artifacts").json()["artifacts"]
    assert len(arts) == 1


def test_typed_context_is_versioned_and_never_replays_chat(client, monkeypatch):
    task = _task(client)
    _add_model_provider(client)
    ctx = client.get(f"/agent-tasks/{task['id']}/context").json()
    assert ctx["version"] == 1
    assert ctx["context"]["schema_version"] == 1
    assert ctx["context"]["task_id"] == task["id"]
    assert "buckets_in_focus" in ctx["context"]
    assert "open_decisions" in ctx["context"]

    # An execution that changes durable state bumps the version.
    monkeypatch.setattr(session_agent, "SESSION_LOOP",
                        lambda spec: _contract(proposals=[_gated_proposal()]))
    execution = client.post(f"/agent-tasks/{task['id']}/executions",
                            json={"direction": "import", "turn_id": "c1"}).json()["execution"]
    _wait_settled(client, task["id"], execution["id"])
    ctx2 = client.get(f"/agent-tasks/{task['id']}/context").json()
    assert ctx2["version"] > ctx["version"]
    assert ctx2["context"]["open_decisions"]


# --- compatibility shims stay on the ONE lifecycle ----------------------------------


def test_legacy_blocking_endpoint_rides_the_durable_runtime(client, monkeypatch):
    task = _task(client)
    _add_model_provider(client)
    monkeypatch.setattr(session_agent, "SESSION_LOOP", lambda spec: _contract("legacy ok"))
    r = client.post(f"/sessions/{task['id']}/messages",
                    json={"content": "hello", "turn_id": "legacy1"})
    assert r.status_code == 200
    body = r.json()
    assert body["execution_id"]
    assert body["execution_status"] == "completed"
    # The same execution is visible through the product API — one lifecycle.
    row = client.get(f"/agent-tasks/{task['id']}/executions/{body['execution_id']}").json()
    assert row["turn_id"] == "legacy1"


def test_no_second_submit_path(client):
    """Executable architecture guard: the sessions router owns NO turn loop of
    its own — both message endpoints delegate to the task runtime."""
    import pathlib
    src = (pathlib.Path(__file__).resolve().parents[1] /
           "app" / "routers" / "sessions.py").read_text()
    assert "runtime.submit" in src
    assert "threading.Thread" not in src
    assert "turn_guard" not in src
    assert "session_agent.answer(" not in src
    assert "build_stream" not in src


@pytest.fixture(autouse=True)
def _quiet_worker_teardown():
    yield
    # Give any daemon worker a beat to finish before the temp DB goes away.
    time.sleep(0.05)
