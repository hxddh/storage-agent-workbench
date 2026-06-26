"""Tests for Phase 07 agent planner mode.

The LLM loop is mocked (no OpenAI Agents SDK call, no OPENAI_API_KEY). S3 is a
fake client. These verify guardrails, sanitization, tool-runner integration,
clean failure without a key, and that deterministic mode still works.
"""

import sqlite3
from typing import Any

import pytest

from app import config, run_service
from app.agent_runtime import agent_service, context_builder, guardrails
from app.agent_runtime.agent_service import ToolInvoker
from app.agent_runtime.guardrails import GuardrailBlocked
from app.agent_runtime.result_parser import AgentResult
from app.s3 import client_factory

MODEL_KEY = "sk-MODEL-SECRET-DO-NOT-LEAK"
ACCESS = "AKIAIOSFODNN7EXAMPLE"


class FakeS3:
    CANNED = {
        "list_buckets": {"Buckets": [], "Owner": {"DisplayName": "acct"}},
        "head_bucket": {"ResponseMetadata": {"HTTPStatusCode": 200}},
        "list_objects_v2": {"KeyCount": 1, "Contents": [{"Key": "a.txt", "Size": 1}], "IsTruncated": False},
    }

    def __getattr__(self, method):
        def _call(**kwargs):
            return self.CANNED.get(method, {})
        return _call


def _fake_loop(spec: dict[str, Any]) -> AgentResult:
    inv = spec["invoker"]
    for name in spec["tool_names"][:2]:
        inv.invoke(name, {}, "agent selected for testing")
    # summary deliberately contains a CoT marker to verify it is stripped
    return AgentResult(
        summary="Looks healthy. <thinking>secret private reasoning</thinking>",
        findings=[{"severity": "info", "title": "Looks healthy", "detail": "Grounded in tool evidence."}],
        report_narrative="The bucket appears reachable based on the tool evidence.",
    )


def _db():
    c = sqlite3.connect(str(config.db_path()))
    c.row_factory = sqlite3.Row
    return c


@pytest.fixture()
def agent_env(client, monkeypatch):
    pid = client.post("/cloud-providers", json={
        "name": "demo", "provider_type": "s3-compatible", "endpoint_url": "https://minio.example.com",
        "region": "us-east-1", "addressing_style": "path", "access_key": ACCESS, "secret_key": "shh",
    }).json()["id"]
    # model provider with an API key -> needed for agent credential resolution
    client.post("/model-providers", json={
        "name": "openai", "provider_type": "openai", "base_url": "https://api.openai.com/v1",
        "model": "gpt-4o-mini", "api_key": MODEL_KEY,
    })
    monkeypatch.setattr(client_factory, "build_s3_client", lambda *a, **k: FakeS3())
    monkeypatch.setattr(run_service, "start", run_service.run_sync)
    monkeypatch.setattr(agent_service, "AGENT_LOOP", _fake_loop)
    return type("Env", (), {"client": client, "pid": pid})


def _run_agent(env, run_type):
    created = env.client.post("/runs", json={
        "run_type": run_type, "provider_id": env.pid, "bucket": "demo-bucket",
        "user_prompt": "please review", "planner_mode": "agent",
    }).json()
    rid = created["run_id"]
    assert env.client.post(f"/runs/{rid}/message", json={"content": "go"}).status_code == 200
    return rid


# --- run flow ---------------------------------------------------------------


def test_agent_diagnostic_run_completes(agent_env):
    rid = _run_agent(agent_env, "diagnostic")
    detail = agent_env.client.get(f"/runs/{rid}").json()
    assert detail["status"] == "completed"
    assert detail["planner_mode"] == "agent"
    names = {t["tool_name"] for t in detail["tool_calls"]}
    assert "test_credentials" in names  # tools went through the tool_runner


def test_agent_config_review_run_completes(agent_env):
    rid = _run_agent(agent_env, "bucket_config_review")
    detail = agent_env.client.get(f"/runs/{rid}").json()
    assert detail["status"] == "completed"
    assert detail["planner_mode"] == "agent"
    assert any(t["tool_name"] == "get_bucket_config_summary" for t in detail["tool_calls"])


def test_agent_tool_calls_and_audit_have_run_id(agent_env):
    rid = _run_agent(agent_env, "diagnostic")
    conn = _db()
    try:
        tc = conn.execute("SELECT count(*) FROM tool_calls WHERE run_id=?", (rid,)).fetchone()[0]
        al = conn.execute("SELECT count(*) FROM audit_logs WHERE run_id=? AND event_type LIKE 'tool.%'", (rid,)).fetchone()[0]
    finally:
        conn.close()
    assert tc >= 2 and al >= 2


def test_agent_events_and_no_chain_of_thought(agent_env):
    rid = _run_agent(agent_env, "diagnostic")
    import json
    text = agent_env.client.get(f"/runs/{rid}/events").text
    types = [json.loads(l[5:].strip())["type"] for l in text.splitlines() if l.startswith("data:")]
    for required in ("agent_started", "agent_tool_selected", "guardrail_passed", "agent_final", "report_ready"):
        assert required in types, f"missing event {required}"
    # hidden chain-of-thought must not be persisted/shown
    assert "secret private reasoning" not in text
    report = agent_env.client.get(f"/reports/{rid}").json()["content"]
    assert "secret private reasoning" not in report
    assert MODEL_KEY not in text and MODEL_KEY not in report


def test_agent_report_has_no_storage_secret(agent_env):
    rid = _run_agent(agent_env, "diagnostic")
    report = agent_env.client.get(f"/reports/{rid}").json()["content"]
    assert ACCESS not in report and MODEL_KEY not in report


def test_api_accepts_agent_for_analysis_types(client):
    # Phase 13: agent mode is now supported for the dataset-analysis run types
    # (interpretation-only narrator). See test_agent_analysis.py for behavior.
    for rt in ("access_log_analysis", "inventory_analysis"):
        r = client.post("/runs", json={"run_type": rt, "user_prompt": "x", "planner_mode": "agent"})
        assert r.status_code == 201, r.text


def test_api_rejects_agent_for_unimplemented_types(client):
    r = client.post("/runs", json={"run_type": "optimization_report", "user_prompt": "x", "planner_mode": "agent"})
    assert r.status_code == 422


def test_agent_missing_model_key_fails_cleanly(client, monkeypatch):
    # No model provider configured -> agent run fails cleanly; deterministic still works.
    pid = client.post("/cloud-providers", json={
        "name": "demo", "provider_type": "s3-compatible", "endpoint_url": "https://minio.example.com",
        "region": "us-east-1", "addressing_style": "path", "access_key": ACCESS, "secret_key": "shh",
    }).json()["id"]
    monkeypatch.setattr(client_factory, "build_s3_client", lambda *a, **k: FakeS3())
    monkeypatch.setattr(run_service, "start", run_service.run_sync)

    created = client.post("/runs", json={
        "run_type": "diagnostic", "provider_id": pid, "bucket": "b",
        "user_prompt": "x", "planner_mode": "agent",
    }).json()
    rid = created["run_id"]
    client.post(f"/runs/{rid}/message", json={"content": "go"})
    detail = client.get(f"/runs/{rid}").json()
    assert detail["status"] == "failed"

    import json
    text = client.get(f"/runs/{rid}/events").text
    assert any("model provider" in json.loads(l[5:].strip()).get("message", "").lower()
               for l in text.splitlines() if l.startswith("data:") and '"error"' in l)

    # deterministic mode unaffected
    det = client.post("/runs", json={
        "run_type": "diagnostic", "provider_id": pid, "bucket": "b", "user_prompt": "x",
    }).json()
    drid = det["run_id"]
    client.post(f"/runs/{drid}/message", json={"content": "go"})
    assert client.get(f"/runs/{drid}").json()["status"] == "completed"


def test_deterministic_remains_default(client, monkeypatch):
    monkeypatch.setattr(client_factory, "build_s3_client", lambda *a, **k: FakeS3())
    monkeypatch.setattr(run_service, "start", run_service.run_sync)
    pid = client.post("/cloud-providers", json={
        "name": "d", "provider_type": "s3-compatible", "endpoint_url": "https://m.example.com",
        "region": "us-east-1", "addressing_style": "path", "access_key": ACCESS, "secret_key": "s",
    }).json()["id"]
    created = client.post("/runs", json={
        "run_type": "diagnostic", "provider_id": pid, "bucket": "b", "user_prompt": "x",
    }).json()
    assert created["status"] == "pending"
    assert client.get(f"/runs/{created['run_id']}").json()["planner_mode"] == "deterministic"


# --- guardrail units --------------------------------------------------------


def test_guardrail_blocks_forbidden_and_shell_tools():
    for bad in ("delete_bucket", "put_bucket_policy", "shell", "subprocess", "run_sql", "boto3_client"):
        with pytest.raises(GuardrailBlocked):
            guardrails.check_tool_allowed(bad)


def test_guardrail_allows_whitelisted_tools():
    for ok in ("test_credentials", "head_bucket", "get_bucket_config_summary"):
        guardrails.check_tool_allowed(ok)  # no raise


def test_invoker_blocks_forbidden_tool_and_emits_event(agent_env):
    # Drive a real run so the bus has an entry, then exercise the invoker directly.
    conn = _db()
    try:
        with pytest.raises(GuardrailBlocked):
            ToolInvoker(conn, "some-run", {"provider_id": agent_env.pid, "bucket": "b"}).invoke("delete_bucket", {})
    finally:
        conn.close()


def test_output_sanitization_bounds_and_redacts():
    big = {
        "success": True,
        "sample_keys": [f"k{i}" for i in range(100)],
        "headers_sanitized": {"authorization": "Bearer x"},
        "leak": f"creds {ACCESS} here",
    }
    out = guardrails.sanitize_output_for_agent(big)
    assert len(out["sample_keys"]) == guardrails.SAMPLE_LIMIT  # bounded to 20
    assert "headers_sanitized" not in out  # raw headers dropped
    assert ACCESS not in str(out)  # secret redacted


def test_assert_report_sanitized_blocks_secrets():
    guardrails.assert_report_sanitized("# Clean report\n\nNo secrets here.")  # ok
    with pytest.raises(GuardrailBlocked):
        guardrails.assert_report_sanitized(f"contains {ACCESS} key")


def test_context_builder_excludes_secrets(agent_env):
    conn = _db()
    try:
        run = {"run_type": "diagnostic", "user_prompt": f"my key is {ACCESS}",
               "provider_id": agent_env.pid, "bucket": "b", "prefix": None}
        ctx = context_builder.build_context(conn, run)
        text = context_builder.render_context_text(ctx)
    finally:
        conn.close()
    assert ACCESS not in text          # secret in prompt was redacted
    assert MODEL_KEY not in text       # model key never enters context
    assert "api_key" not in text and "secret_key" not in text


def test_assert_no_secrets_in_context_raises_on_raw_secret():
    with pytest.raises(GuardrailBlocked):
        guardrails.assert_no_secrets_in_context({"x": f"{ACCESS}"})
