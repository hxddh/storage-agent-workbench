"""Tests for Phase 1 agent autonomy: policy, settings, and inline execution.

Under the ``advisory`` policy the agent only proposes (the old behavior). Under
``assisted``/``autonomous_readonly`` it may EXECUTE read-only runs itself; these
verify the policy gating, the settings endpoint, and that the inline executor
tools create + run a real read-only run and return its sanitized summary —
without exposing any write/destructive capability.
"""

import json
import sqlite3

from app import config, run_service
from app.agent_runtime import autonomy, session_action_tools, session_agent
from app.db import connect as db_connect


def _fake_function_tool(fn):  # mimic the SDK decorator enough for build()
    fn.name = fn.__name__
    return fn


def _tool_names(tools):
    return {getattr(t, "name", getattr(t, "__name__", "")) for t in tools}


# --- policy unit logic ------------------------------------------------------


def test_normalize_defaults_to_assisted():
    assert autonomy.normalize(None) == autonomy.ASSISTED
    assert autonomy.normalize("nonsense") == autonomy.ASSISTED
    assert autonomy.normalize("ADVISORY") == autonomy.ADVISORY


def test_executes_inline_by_policy():
    assert autonomy.executes_inline(autonomy.ADVISORY) is False
    assert autonomy.executes_inline(autonomy.ASSISTED) is True
    assert autonomy.executes_inline(autonomy.AUTONOMOUS_READONLY) is True


def test_may_execute_only_safe_readonly():
    # Safe read-only runs execute under assisted+; expensive/data-moving never do.
    assert autonomy.may_execute(autonomy.ASSISTED, "run_diagnostic") is True
    assert autonomy.may_execute(autonomy.ASSISTED, "run_account_discovery") is True
    assert autonomy.may_execute(autonomy.ASSISTED, "run_access_log_analysis") is False
    assert autonomy.may_execute(autonomy.ASSISTED, "plan_inventory_import") is False
    # Advisory never executes anything itself.
    assert autonomy.may_execute(autonomy.ADVISORY, "run_diagnostic") is False


# --- tool gating ------------------------------------------------------------


def test_action_tools_gated_by_policy():
    conn = sqlite3.connect(":memory:")
    try:
        assert session_action_tools.build(conn, _fake_function_tool, autonomy.ADVISORY) == []
        assisted = session_action_tools.build(conn, _fake_function_tool, autonomy.ASSISTED)
    finally:
        conn.close()
    assert _tool_names(assisted) == {
        "run_diagnostic", "run_bucket_config_review", "run_account_discovery",
    }


def test_no_mutating_tool_ever_exposed():
    from app.agent_runtime import guardrails
    conn = sqlite3.connect(":memory:")
    try:
        tools = session_action_tools.build(conn, _fake_function_tool, autonomy.AUTONOMOUS_READONLY)
    finally:
        conn.close()
    for n in _tool_names(tools):
        assert not guardrails.is_forbidden_tool(n), f"forbidden tool exposed: {n}"


def test_instructions_gain_execution_clause_only_when_inline():
    assert "EXECUTE read-only runs" not in session_agent.instructions_for(autonomy.ADVISORY)
    assert "EXECUTE read-only runs" in session_agent.instructions_for(autonomy.ASSISTED)


# --- settings endpoint ------------------------------------------------------


def test_autonomy_setting_defaults_and_updates(client):
    got = client.get("/settings/autonomy").json()
    assert got["policy"] == autonomy.DEFAULT_POLICY == "assisted"
    assert set(got["policies"]) == set(autonomy.POLICIES)

    put = client.put("/settings/autonomy", json={"policy": "advisory"})
    assert put.status_code == 200 and put.json()["policy"] == "advisory"
    assert client.get("/settings/autonomy").json()["policy"] == "advisory"

    bad = client.put("/settings/autonomy", json={"policy": "yolo"})
    assert bad.status_code == 422


# --- inline execution actually runs a read-only run -------------------------


def test_inline_executor_runs_real_readonly_run(client, monkeypatch):
    """run_diagnostic creates + runs a real (read-only) run, links it to the
    session, and returns the run's sanitized summary."""
    pid = client.post("/cloud-providers", json={
        "name": "demo", "provider_type": "s3-compatible", "endpoint_url": "https://m",
        "region": "us-east-1", "addressing_style": "path",
        "access_key": "AKIAIOSFODNN7EXAMPLE", "secret_key": "s"}).json()["id"]
    sid = client.post("/sessions", json={"title": "t", "goal": "g", "provider_id": pid}).json()["id"]

    # Stand in for the real executor: mark the run completed with a summary,
    # using its own connection like run_service.run_sync does.
    def fake_run_sync(run_id):
        c = db_connect()
        try:
            c.execute("UPDATE runs SET status='completed', final_summary=? WHERE id=?",
                      ("Credentials valid; bucket reachable.", run_id))
            c.commit()
        finally:
            c.close()

    monkeypatch.setattr(run_service, "run_sync", fake_run_sync)

    conn = sqlite3.connect(str(config.db_path()))
    conn.row_factory = sqlite3.Row
    try:
        activity: list[dict] = []
        tools = session_action_tools.build(conn, _fake_function_tool, autonomy.ASSISTED,
                                           activity, sid)
        run_diagnostic = next(t for t in tools if t.name == "run_diagnostic")
        out = json.loads(run_diagnostic(pid, "bucket-x"))
    finally:
        conn.close()

    assert out["status"] == "completed"
    assert out["final_summary"] == "Credentials valid; bucket reachable."
    assert activity and activity[0]["tool"] == "run_diagnostic"

    # A real run was persisted and linked to the session timeline.
    runs = client.get("/runs").json()
    assert any(r["run_type"] == "diagnostic" for r in runs)
    detail = client.get(f"/sessions/{sid}").json()
    assert any(r["run_type"] == "diagnostic" for r in detail["runs"])


def test_inline_executor_rejects_unknown_provider(client, monkeypatch):
    sid = client.post("/sessions", json={"title": "t", "goal": "g"}).json()["id"]
    monkeypatch.setattr(run_service, "run_sync", lambda run_id: None)
    conn = sqlite3.connect(str(config.db_path()))
    conn.row_factory = sqlite3.Row
    try:
        tools = session_action_tools.build(conn, _fake_function_tool, autonomy.ASSISTED, [], sid)
        run_diagnostic = next(t for t in tools if t.name == "run_diagnostic")
        out = json.loads(run_diagnostic("no-such-provider", "b"))
    finally:
        conn.close()
    assert "error" in out
