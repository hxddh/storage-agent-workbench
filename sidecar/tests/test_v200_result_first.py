"""v2.0 result-first Task — the Work Result's conclusion is runtime-recorded.

The Task page opens on the latest Work Result's conclusion (answer, findings
with severity, next steps). These tests pin the contract that makes that
honest: the conclusion exists only when the model called ``record_conclusion``;
it is bounded, redacted and stripped of hidden reasoning; it is never a tool
row; it is persisted on the assistant message and the durable Work Result
(migration 031) and announced as a ``conclusion.recorded`` event.
"""

from __future__ import annotations

import time


from .fake_model import FakeModel, text_turn, tool_turn

MODEL_KEY = "sk-TESTKEY-DONOTLEAK-0200"
FAKE_KEY = "sk-FAKEKEY-DONOTLEAK-0220"


def _task(client, title="Why does acme-logs deny list"):
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


def test_normalize_bounds_redacts_and_maps_severity():
    from app.agent_runtime import conclusion_tools as c
    out = c.normalize(
        "  acme-logs denies list:\n the policy omits s3:ListBucket <think>hidden</think> ",
        [{"title": "Policy omits ListBucket", "severity": "CRITICAL", "detail": "x" * 900},
         {"title": "key AKIAIOSFODNN7EXAMPLE leaked", "severity": "warning", "detail": ""},
         {"title": "", "severity": "high"},
         "No lifecycle rule",
         {"title": "odd", "severity": "catastrophic"}] + [{"title": f"f{i}", "severity": "low"}
                                                          for i in range(20)],
        ["Draft a remediation plan", "", "y" * 400, "a", "b", "c"])
    assert out is not None
    assert out["answer"] == "acme-logs denies list: the policy omits s3:ListBucket"
    assert len(out["findings"]) == c.MAX_FINDINGS
    assert out["findings"][0]["severity"] == "high"
    assert len(out["findings"][0]["detail"]) == c.MAX_FINDING_DETAIL
    assert out["findings"][1]["severity"] == "medium"
    assert "AKIAIOSFODNN7EXAMPLE" not in out["findings"][1]["title"]
    assert "detail" not in out["findings"][1]
    assert out["findings"][2] == {"title": "No lifecycle rule", "severity": "info"}
    assert out["findings"][3]["severity"] == "info"  # unknown severity → info
    assert out["next_steps"][0] == "Draft a remediation plan"
    assert len(out["next_steps"]) == c.MAX_NEXT_STEPS
    assert len(out["next_steps"][1]) == c.MAX_NEXT_STEP_CHARS
    assert c.normalize("   ", [], []) is None
    assert c.bounded("not a dict") is None


def test_record_conclusion_is_a_core_budget_exempt_tool_and_the_prompt_teaches_it():
    from agents import function_tool

    from app.agent_runtime import conclusion_tools, limits, prompt
    assert "record_conclusion" in limits._CORE_TOOLS
    assert "record_conclusion" in limits._BUDGET_EXEMPT_TOOLS
    activity: list[dict] = []
    tool = conclusion_tools.build(function_tool, activity)[0]
    assert tool.name == "record_conclusion"
    assert "record_conclusion" in prompt.INSTRUCTIONS
    # The tool-less finalize pass cannot call tools; it must not be taught one.
    assert "record_conclusion" not in prompt.FINALIZE_INSTRUCTIONS


def test_last_conclusion_wins_and_it_is_never_a_tool_row():
    from app.agent_runtime import conclusion_tools, finalize, stream
    activity = [
        {"id": "a", "tool": "record_conclusion", "status": "completed",
         "conclusion": {"answer": "first", "findings": [], "next_steps": []}},
        {"id": "b", "tool": "head_bucket", "target": "acme", "ok": True, "status": "completed"},
        {"id": "c", "tool": "record_conclusion", "status": "completed",
         "conclusion": {"answer": "second", "findings": [{"title": "t", "severity": "low",
                                                          "detail": ""}], "next_steps": []}},
    ]
    assert conclusion_tools.latest(activity)["answer"] == "second"
    contract = finalize._finalize_contract("The answer.", [], activity)
    assert contract["conclusion"]["answer"] == "second"
    assert [a["tool"] for a in contract["tool_activity"]] == ["head_bucket"]
    seg = stream._Segments() if hasattr(stream, "_Segments") else None
    if seg is not None:
        seg.tool(activity[0])
        assert not any(i.get("kind") == "tool" for i in seg.items)


def test_migration_031_adds_the_conclusion_columns(client):
    from app.db import connect
    conn = connect()
    try:
        msg_cols = {r[1] for r in conn.execute("PRAGMA table_info(session_messages)")}
        wr_cols = {r[1] for r in conn.execute("PRAGMA table_info(work_results)")}
        assert "conclusion" in msg_cols
        assert "conclusion_json_sanitized" in wr_cols
        head = conn.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0]
        assert int(head) == 31
    finally:
        conn.close()


def _fake_provider(client, model):
    client.post("/model-providers", json={
        "name": "fake", "provider_type": "openai-compatible", "base_url": model.base_url,
        "model": "fake-model", "api_key": FAKE_KEY})


def test_a_recorded_conclusion_lands_on_the_message_the_work_result_and_the_log(client):
    # v2.2 — driven on the streamed path production runs (fake endpoint), not
    # the blocking SESSION_LOOP seam: the SDK really dispatches the tool call.
    task = _task(client)
    conclusion = {"answer": "acme-logs denies list because the policy omits s3:ListBucket.",
                  "findings": [{"title": "Policy omits s3:ListBucket", "severity": "high",
                                "detail": "Every ListObjectsV2 returns 403."}],
                  "next_steps": ["Draft a remediation plan"]}
    with FakeModel([tool_turn("read_skill", {"name": "storageops-security-iam-policy"}),
                    tool_turn("record_conclusion", conclusion),
                    text_turn("## Why\nThe policy omits ListBucket.")]) as model:
        _fake_provider(client, model)
        ex = client.post(f"/agent-tasks/{task['id']}/executions",
                         json={"direction": "why does acme-logs deny list?"}).json()["execution"]
        row = _wait_settled(client, task["id"], ex["id"])
        assert row["status"] == "completed", row.get("error")

    msg = [m for m in client.get(f"/sessions/{task['id']}").json()["messages"]
           if m["role"] == "assistant"][-1]
    assert msg["conclusion"] == conclusion
    # The conclusion is runtime structure, never a tool row.
    assert [a["tool"] for a in msg["tool_activity"]] == ["read_skill"]

    wrs = client.get(f"/agent-tasks/{task['id']}/work-results").json()["work_results"]
    assert wrs[-1]["conclusion"] == conclusion

    events = client.get(f"/agent-tasks/{task['id']}/events?after=0&limit=1000").json()["events"]
    recorded = [e["payload"] for e in events if e["event_type"] == "conclusion.recorded"]
    assert recorded == [conclusion]
    assert FAKE_KEY not in str(msg) and FAKE_KEY not in str(events)


def test_no_conclusion_means_none_never_a_guessed_head(client):
    task = _task(client, "Say hello")
    with FakeModel([text_turn("Hello. What should I check?")]) as model:
        _fake_provider(client, model)
        ex = client.post(f"/agent-tasks/{task['id']}/executions",
                         json={"direction": "hi"}).json()["execution"]
        assert _wait_settled(client, task["id"], ex["id"])["status"] == "completed"
    msg = [m for m in client.get(f"/sessions/{task['id']}").json()["messages"]
           if m["role"] == "assistant"][-1]
    assert msg["conclusion"] is None
    wrs = client.get(f"/agent-tasks/{task['id']}/work-results").json()["work_results"]
    assert wrs[-1]["conclusion"] is None
