"""v1.12.0 — "Native all the way through" contracts.

One protocol (no message/turn shims), push transport, the model's plan tool,
the approval policy enforced in ONE place, the large-survey gate, context
compaction, and the AGENTS.md instructions file.
"""

from __future__ import annotations

import json
import threading
import time

from tests.test_v111_native_turns import (  # noqa: F401 — shared helpers
    MODEL_KEY, _add_model_provider, _approval_execution, _proposal, _task, _wait_settled,
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
    assert "/settings/approval-policy" in paths
    assert "/settings/instructions" in paths


def test_migration_030_adds_the_compaction_columns(client):
    from app.db import connect
    conn = connect()
    try:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(task_context_versions)")}
        assert {"summary_sanitized", "summary_through_seq"} <= cols
        head = conn.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0]
        assert int(head) == 30
    finally:
        conn.close()


# --- W4: approval policy ---------------------------------------------------------


def test_policy_endpoint_round_trips_and_session_grant_is_process_scoped(client):
    from app.task_runtime import approval_policy
    r = client.get("/settings/approval-policy")
    assert r.status_code == 200
    assert r.json()["policy"] == "ask"
    names = {t["name"] for t in r.json()["gated_tools"]}
    assert names == {"import_evidence", "survey_account"}
    assert client.put("/settings/approval-policy", json={"policy": "bogus"}).status_code == 422

    assert client.put("/settings/approval-policy", json={"policy": "allow_session"}
                      ).json()["policy"] == "allow_session"
    assert client.get("/settings/approval-policy").json()["policy"] == "allow_session"
    # A restart (new process) forgets the session grant …
    approval_policy.reset_session()
    assert client.get("/settings/approval-policy").json()["policy"] == "ask"
    # … but `allow_always` is durable configuration (never a secret).
    client.put("/settings/approval-policy", json={"policy": "allow_always"})
    approval_policy.reset_session()
    assert client.get("/settings/approval-policy").json()["policy"] == "allow_always"
    client.put("/settings/approval-policy", json={"policy": "ask"})
    assert client.get("/settings/approval-policy").json()["policy"] == "ask"


def test_policy_answers_the_gate_in_request_approval_only(client):
    from app.db import connect
    from app.task_runtime import runtime
    task = _task(client)
    execution, handle = _approval_execution(client, task["id"])
    client.put("/settings/approval-policy", json={"policy": "allow_session"})
    conn = connect()
    try:
        t0 = time.monotonic()
        granted = runtime.request_approval(
            conn, execution["id"], task["id"], action_type="import_inventory",
            title="Import 3 inventory files", reason=None, proposal=_proposal(),
            cancel_event=handle.cancel_event)
        assert time.monotonic() - t0 < 1.0
        assert granted["status"] == "approved" and granted["scope"] == "session"
        assert "policy" in (granted.get("resolution_note") or "")
        # The execution never went to `waiting`.
        assert client.get(f"/agent-tasks/{task['id']}/executions/{execution['id']}"
                          ).json()["status"] == "running"
    finally:
        conn.close()
    events = client.get(f"/agent-tasks/{task['id']}/events").json()["events"]
    granted_events = [e for e in events if e["event_type"] == "approval.granted"]
    assert granted_events and granted_events[-1]["payload"]["policy"] == "session"
    assert not any(e["event_type"] == "approval.opened" for e in events)

    # Back to `ask`: the same call pauses again (a policy is not a grant).
    client.put("/settings/approval-policy", json={"policy": "ask"})
    out: list = []

    def tool_thread():
        c = connect()
        try:
            out.append(runtime.request_approval(
                c, execution["id"], task["id"], action_type="import_access_log",
                title="Import logs", reason=None, proposal=_proposal(),
                cancel_event=handle.cancel_event))
        finally:
            c.close()

    t = threading.Thread(target=tool_thread, daemon=True)
    t.start()
    deadline = time.monotonic() + 5
    pending: list = []
    while time.monotonic() < deadline:
        pending = client.get(f"/agent-tasks/{task['id']}/decisions?status_filter=pending"
                             ).json()["decisions"]
        if pending:
            break
        time.sleep(0.05)
    assert pending and pending[0]["action_type"] == "import_access_log"
    client.post(f"/agent-tasks/{task['id']}/decisions/{pending[0]['id']}/resolve",
                json={"resolution": "declined"})
    t.join(5)
    assert out and out[0]["status"] == "declined"
    with runtime._lock:
        runtime._live.pop(execution["id"], None)


# --- W4: the large-survey gate ---------------------------------------------------


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


def test_survey_above_the_default_cap_crosses_the_confirmation_boundary(client, monkeypatch):
    from app.agent_runtime import session_action_tools
    from app.db import connect
    from app.task_runtime import runtime, store
    pid = _cloud_provider(client)
    task = _task(client)
    execution, handle = _approval_execution(client, task["id"])
    seen: dict = {}

    def fake_execute_run(conn, body, turn_id, dedup_key, cancel_event=None):
        seen["max_buckets"] = body.max_buckets
        raise RuntimeError("stop here — the gate is what this test checks")

    monkeypatch.setattr(session_action_tools, "_execute_run", fake_execute_run)
    conn = connect()
    try:
        activity: list = []
        tools = {t.name: t for t in session_action_tools.build(
            conn, _FT(), activity, session_id=task["id"], turn_id=execution["turn_id"],
            cancel_event=handle.cancel_event)}
        survey = tools["survey_account"]

        # Default cap: autonomous, no Decision.
        survey(pid)
        assert seen["max_buckets"] is None
        assert not client.get(f"/agent-tasks/{task['id']}/decisions?status_filter=pending"
                              ).json()["decisions"]

        # Above the cap: a Decision with the projected impact; Deny → refusal,
        # nothing enumerated.
        out: dict = {}

        def call():
            c = connect()
            try:
                tools2 = {t.name: t for t in session_action_tools.build(
                    c, _FT(), activity, session_id=task["id"], turn_id=execution["turn_id"],
                    cancel_event=handle.cancel_event)}
                out["text"] = tools2["survey_account"](pid, 300)
            finally:
                c.close()

        seen.clear()
        t = threading.Thread(target=call, daemon=True)
        t.start()
        deadline = time.monotonic() + 5
        pending: list = []
        while time.monotonic() < deadline:
            pending = client.get(f"/agent-tasks/{task['id']}/decisions?status_filter=pending"
                                 ).json()["decisions"]
            if pending:
                break
            time.sleep(0.05)
        assert pending and pending[0]["action_type"] == "survey_account_large"
        impact = pending[0]["impact"]
        assert impact["gate"] == "large_scan" and impact["buckets"] == 300
        assert impact["estimated_calls"] >= 300 and impact["provider"] == "acme"
        client.post(f"/agent-tasks/{task['id']}/decisions/{pending[0]['id']}/resolve",
                    json={"resolution": "declined"})
        t.join(5)
        assert "declined" in out["text"] and "max_buckets" not in seen
        assert activity[-1]["tool"] == "survey_account" and activity[-1]["ok"] is False

        # Allowed by policy: the same call proceeds at the requested cap.
        client.put("/settings/approval-policy", json={"policy": "allow_always"})
        text = survey(pid, 300)
        assert seen["max_buckets"] == 300 and "failed" in text
        ev = client.get(f"/agent-tasks/{task['id']}/events").json()["events"]
        assert any(e["event_type"] == "approval.granted" and e["payload"]["policy"] == "always"
                   and e["payload"]["action_type"] == "survey_account_large" for e in ev)
        client.put("/settings/approval-policy", json={"policy": "ask"})

        # Not attached to a durable execution: clamped to the default, never widened.
        tools3 = {t.name: t for t in session_action_tools.build(conn, _FT(), [],
                                                                session_id=task["id"])}
        seen.clear()
        tools3["survey_account"](pid, 400)
        assert seen["max_buckets"] == 100
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
    execution, handle = _approval_execution(client, task["id"])
    try:
        assert client.post(f"/agent-tasks/{task['id']}/compact").status_code == 409
    finally:
        from app.task_runtime import runtime
        with runtime._lock:
            runtime._live.pop(execution["id"], None)


def test_runtime_compacts_before_the_model_loop_when_the_window_is_full(client, monkeypatch):
    from app.agent_runtime import compaction, session_agent
    _add_model_provider(client)
    task = _task(client)
    _seed_turns(client, task["id"], 2)
    # Make the declared window small enough that the last turn (2000 tokens) fills it.
    from app.agent_runtime import agent_service
    real = agent_service.get_model_credentials

    def small_window(conn):
        creds = real(conn)
        creds["context_window"] = 2400
        return creds

    monkeypatch.setattr("app.task_runtime.runtime.get_model_credentials", small_window)
    monkeypatch.setattr(compaction, "COMPACT_STEP",
                        lambda creds, msgs, prior: "Summary: two turns; acme-logs public.")
    seen_ctx: dict = {}

    def fake_loop(spec):
        seen_ctx["prompt"] = spec["prompt"]
        return {"answer": "Continuing.", "skills_used": [], "skills_offered": [],
                "evidence_used": [], "evidence_gaps": [], "tool_activity": [],
                "turn_items": [{"kind": "message", "text": "ok"}]}

    monkeypatch.setattr(session_agent, "SESSION_LOOP", fake_loop)
    ex = client.post(f"/agent-tasks/{task['id']}/executions",
                     json={"direction": "keep going"}).json()["execution"]
    assert _wait_settled(client, task["id"], ex["id"])["status"] == "completed"
    events = client.get(f"/agent-tasks/{task['id']}/events").json()["events"]
    ev = [e for e in events if e["event_type"] == "context.compacted"]
    assert len(ev) == 1 and ev[0]["execution_id"] == ex["id"]
    assert ev[0]["payload"]["before_tokens"] == 2000
    assert "Summary: two turns; acme-logs public." in seen_ctx["prompt"]
    assert "question 0 about acme-logs" not in seen_ctx["prompt"]
    msg = [m for m in _messages(client, task["id"]) if m["role"] == "assistant"][-1]
    assert msg["turn_items"][0] == {"kind": "compacted", "before_tokens": 2000,
                                    "after_tokens": ev[0]["payload"]["after_tokens"]}
    assert msg["turn_items"][1] == {"kind": "message", "text": "ok"}


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
    assert prompt.index("operator_instructions") < prompt.index("User question:")
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
