"""Tests for Phase 13 agent dataset-analysis (interpretation-only narrator).

The LLM loop is mocked (no OpenAI Agents SDK call, no API key). Deterministic
analysis always runs first; the agent only interprets the sanitized aggregates.
These verify: agent mode works for both analysis run types, the context is
bounded + sanitized (no raw rows, ≤20 samples, masked IPs, redacted secrets, no
model key), the agent adds no tools / no SQL, output is CoT-stripped + redacted,
missing key fails cleanly, the report distinguishes deterministic vs agent, and
deterministic mode is unaffected.
"""

import json
import sqlite3
from typing import Any

import pytest

from app import config, run_service
from app.agent_runtime import analysis_agent, guardrails
from app.agent_runtime.guardrails import GuardrailBlocked

MODEL_KEY = "sk-MODEL-SECRET-DO-NOT-LEAK"
ACCESS = "AKIAIOSFODNN7EXAMPLE"

# Access log with a secret-bearing user agent and real client IPs (both must be
# masked/redacted before reaching the agent context).
ACCESS_LOG_JSONL = (
    json.dumps({"timestamp": "2026-06-25T11:00:00Z", "method": "GET", "path": "/a/b.txt",
                "status": 200, "bytes": 10, "user_agent": "Bearer sk-LEAK-TOKEN-123",
                "remote_ip": "203.0.113.7"}) + "\n"
)
ACCESS_LOG_TEXT = (
    '2026-06-25T10:00:00Z bucket-alpha GET /datasets/train/p1.parquet 206 1048576 42 ms '
    'user-agent="aws-sdk/1.0" remote_ip="192.0.2.10"\n'
    '2026-06-25T10:00:02Z bucket-alpha GET /private/secret.txt 403 0 12 ms '
    'user-agent="curl/8" remote_ip="192.0.2.12"\n'
    '2026-06-25T10:00:03Z bucket-alpha GET /missing.txt 404 0 10 ms '
    'user-agent="curl/8" remote_ip="192.0.2.13"\n'
)
INVENTORY_CSV = (
    "Bucket,Key,Size,LastModified,StorageClass,ETag\n"
    "b,datasets/train/p1.parquet,536870912,2026-06-20T12:00:00Z,STANDARD,e1\n"
    "b,datasets/train/p2.parquet,536870912,2024-01-01T12:00:00Z,STANDARD,e2\n"
    "b,logs/app.log,2048,2026-06-25T10:00:00Z,STANDARD_IA,e3\n"
    "b,tmp/small.txt,512,2026-06-25T09:00:00Z,STANDARD,e4\n"
)


def _db():
    c = sqlite3.connect(str(config.db_path()))
    c.row_factory = sqlite3.Row
    return c


def _add_model_provider(client):
    return client.post("/model-providers", json={
        "name": "openai", "provider_type": "openai", "base_url": "https://api.openai.com/v1",
        "model": "gpt-4o-mini", "api_key": MODEL_KEY,
    })


def _access_log_output() -> dict[str, Any]:
    # CoT marker + secret deliberately injected to verify stripping/redaction.
    # 30 observations to verify the parser caps lists at SAMPLE_LIMIT.
    return {
        "executive_summary": f"Elevated client errors. <thinking>raw {ACCESS} reasoning</thinking>",
        "key_observations": [f"observation {i}" for i in range(30)],
        "possible_root_causes": ["Clients requesting deleted keys (404s)."],
        "risk_level": "medium",
        "recommended_next_steps": ["Audit the 403 sources."],
        "questions_for_operator": ["Is this production traffic?"],
        "limitations": "Based only on the uploaded sample.",
        "should_be_dropped": "this key is not in the schema",
    }


def _inventory_output() -> dict[str, Any]:
    return {
        "executive_summary": "Two large parquet objects dominate capacity.",
        "storage_layout_observations": ["Most bytes live under datasets/train/."],
        "cost_optimization_opportunities": ["Cold p2.parquet could move to IA."],
        "performance_considerations": ["Few large objects read well."],
        "lifecycle_policy_candidates": ["Review: transition >180d objects to IA."],
        "small_object_findings": ["tmp/small.txt is tiny."],
        "large_object_findings": ["p1.parquet and p2.parquet are 512 MiB each."],
        "risks_and_caveats": ["Sample may be partial."],
        "recommended_next_steps": ["Confirm access patterns before any change."],
        "extra": "dropped",
    }


def _run_agent_analysis(client, monkeypatch, run_type, dataset_type, filename, content, loop):
    monkeypatch.setattr(run_service, "start", run_service.run_sync)
    monkeypatch.setattr(analysis_agent, "ANALYSIS_LOOP", loop)
    created = client.post("/runs", json={
        "run_type": run_type, "user_prompt": "analyze this", "planner_mode": "agent",
    }).json()
    rid = created["run_id"]
    up = client.post(
        f"/runs/{rid}/datasets/upload",
        files={"file": (filename, content.encode(), "text/plain")},
        data={"dataset_type": dataset_type},
    )
    assert up.status_code == 200, up.text
    assert client.post(f"/runs/{rid}/message", json={"content": "go"}).status_code == 200
    return rid


# --- end to end -------------------------------------------------------------


def test_access_log_agent_run_completes_and_report_has_agent_section(client, monkeypatch):
    _add_model_provider(client)
    rid = _run_agent_analysis(client, monkeypatch, "access_log_analysis", "access_log",
                              "a.jsonl", ACCESS_LOG_JSONL + ACCESS_LOG_TEXT, lambda s: _access_log_output())
    detail = client.get(f"/runs/{rid}").json()
    assert detail["status"] == "completed"
    assert detail["planner_mode"] == "agent"

    report = client.get(f"/reports/{rid}").json()["content"]
    # deterministic metrics AND a clearly separated agent interpretation section
    assert "# Access Log Analysis Report" in report
    assert "## Metrics" in report
    assert "## Agent Interpretation" in report
    assert "Possible root causes" in report


def test_inventory_agent_run_completes_and_report_has_agent_section(client, monkeypatch):
    _add_model_provider(client)
    rid = _run_agent_analysis(client, monkeypatch, "inventory_analysis", "inventory",
                              "inv.csv", INVENTORY_CSV, lambda s: _inventory_output())
    detail = client.get(f"/runs/{rid}").json()
    assert detail["status"] == "completed"
    report = client.get(f"/reports/{rid}").json()["content"]
    assert "# Inventory Analysis Report" in report
    assert "## Agent Interpretation" in report
    assert "Lifecycle policy candidates" in report
    assert "Cost optimization opportunities" in report


def test_deterministic_analysis_runs_first_in_agent_mode(client, monkeypatch):
    _add_model_provider(client)
    rid = _run_agent_analysis(client, monkeypatch, "access_log_analysis", "access_log",
                              "a.log", ACCESS_LOG_TEXT, lambda s: _access_log_output())
    detail = client.get(f"/runs/{rid}").json()
    names = {t["tool_name"] for t in detail["tool_calls"]}
    # the deterministic pipeline ran before the agent narration
    assert {"detect_log_format", "import_access_logs", "analyze_access_logs"} <= names


def test_agent_adds_no_tools_and_no_sql(client, monkeypatch):
    _add_model_provider(client)
    rid = _run_agent_analysis(client, monkeypatch, "inventory_analysis", "inventory",
                              "inv.csv", INVENTORY_CSV, lambda s: _inventory_output())
    detail = client.get(f"/runs/{rid}").json()
    names = [t["tool_name"] for t in detail["tool_calls"]]
    allowed = {"import_inventory_file", "analyze_inventory", "generate_markdown_report"}
    assert set(names) <= allowed  # agent introduced no extra tool
    for n in names:
        assert not guardrails.is_forbidden_tool(n)  # no sql/query/raw/shell tool


def test_agent_output_cot_stripped_and_secrets_redacted(client, monkeypatch):
    _add_model_provider(client)
    rid = _run_agent_analysis(client, monkeypatch, "access_log_analysis", "access_log",
                              "a.jsonl", ACCESS_LOG_JSONL + ACCESS_LOG_TEXT, lambda s: _access_log_output())
    report = client.get(f"/reports/{rid}").json()["content"]
    events = client.get(f"/runs/{rid}/events").text
    for blob in (report, events):
        assert "raw " + ACCESS not in blob
        assert ACCESS not in blob                  # secret redacted
        assert "reasoning</thinking>" not in blob  # CoT stripped
        assert MODEL_KEY not in blob               # model key never surfaces
        assert "sk-LEAK-TOKEN-123" not in blob     # dataset secret stays redacted
        assert "203.0.113.7" not in blob           # client IP masked
        assert "192.0.2.10" not in blob


def test_context_sent_to_model_is_bounded_and_clean(client, monkeypatch):
    _add_model_provider(client)
    captured: list[dict[str, Any]] = []

    def loop(spec):
        captured.append(spec)
        return _access_log_output()

    rid = _run_agent_analysis(client, monkeypatch, "access_log_analysis", "access_log",
                              "a.jsonl", ACCESS_LOG_JSONL + ACCESS_LOG_TEXT, loop)
    assert client.get(f"/runs/{rid}").json()["status"] == "completed"
    assert captured, "ANALYSIS_LOOP was not called"
    spec = captured[0]
    ctx = spec["context"]
    text = spec["context_text"]

    # interpretation-only: no tool-calling machinery is handed to the model
    assert "invoker" not in spec and "tool_names" not in spec and "tools" not in spec
    # context is aggregates only; raw/header/policy buckets are dropped
    assert "deterministic_metrics" in ctx and "deterministic_findings" in ctx
    for dropped in ("headers_sanitized", "raw", "raw_sanitized", "policy", "acl", "data"):
        assert dropped not in ctx["deterministic_metrics"]
    # secrets / PII never reach the model
    assert MODEL_KEY not in text
    assert "sk-LEAK-TOKEN-123" not in text
    assert "203.0.113.7" not in text and "192.0.2.10" not in text


def test_agent_missing_model_key_fails_cleanly_and_deterministic_unaffected(client, monkeypatch):
    monkeypatch.setattr(run_service, "start", run_service.run_sync)
    # No model provider configured -> agent analysis fails cleanly.
    created = client.post("/runs", json={
        "run_type": "inventory_analysis", "user_prompt": "x", "planner_mode": "agent",
    }).json()
    rid = created["run_id"]
    client.post(f"/runs/{rid}/datasets/upload",
                files={"file": ("inv.csv", INVENTORY_CSV.encode(), "text/plain")},
                data={"dataset_type": "inventory"})
    client.post(f"/runs/{rid}/message", json={"content": "go"})
    detail = client.get(f"/runs/{rid}").json()
    assert detail["status"] == "failed"
    events = client.get(f"/runs/{rid}/events").text
    assert any("model provider" in json.loads(l[5:].strip()).get("message", "").lower()
               for l in events.splitlines() if l.startswith("data:") and '"error"' in l)

    # deterministic mode (default) still completes with the same dataset
    det = client.post("/runs", json={"run_type": "inventory_analysis", "user_prompt": "x"}).json()
    drid = det["run_id"]
    client.post(f"/runs/{drid}/datasets/upload",
                files={"file": ("inv.csv", INVENTORY_CSV.encode(), "text/plain")},
                data={"dataset_type": "inventory"})
    client.post(f"/runs/{drid}/message", json={"content": "go"})
    assert client.get(f"/runs/{drid}").json()["status"] == "completed"


def test_api_allows_agent_for_analysis_types(client):
    for rt in ("access_log_analysis", "inventory_analysis"):
        r = client.post("/runs", json={"run_type": rt, "user_prompt": "x", "planner_mode": "agent"})
        assert r.status_code == 201, r.text


# --- unit: context builder --------------------------------------------------


def test_build_analysis_context_caps_lists_and_redacts():
    run = {"id": "r1", "run_type": "inventory_analysis", "created_at": "now", "user_prompt": "p"}
    metrics = {
        "object_count": 5,
        "top_large_objects": [{"key": f"k{i}", "size": i} for i in range(100)],  # > SAMPLE_LIMIT
        "leak": f"presigned ?X-Amz-Signature=abc123 and {ACCESS}",
    }
    findings = [{"severity": "info", "title": "t", "detail": "d"} for _ in range(50)]
    ctx = analysis_agent.build_analysis_context(run, {"dataset_type": "inventory"}, metrics, findings)
    text = json.dumps(ctx)
    assert len(ctx["deterministic_metrics"]["top_large_objects"]) == guardrails.SAMPLE_LIMIT
    assert len(ctx["deterministic_findings"]) == guardrails.SAMPLE_LIMIT
    assert ACCESS not in text                 # secret-shaped value redacted
    assert "X-Amz-Signature=abc123" not in text  # presigned signature redacted


def test_analysis_metrics_carry_no_raw_ip_into_context(tmp_path):
    # The IP-masking guarantee for the agent context comes from upstream: the
    # deterministic analyzer masks client IPs at import and never emits raw IPs
    # into its aggregates, so a context built from them is clean by construction.
    from app.analysis import access_logs

    p = tmp_path / "a.jsonl"
    p.write_text(ACCESS_LOG_JSONL + ACCESS_LOG_TEXT, encoding="utf-8")
    duckdb_path = tmp_path / "a.duckdb"
    fmt = access_logs.detect_log_format(p)["format"]
    access_logs.import_access_logs(p, duckdb_path, fmt)
    metrics = access_logs.analyze_access_logs(duckdb_path)

    run = {"id": "r1", "run_type": "access_log_analysis", "created_at": "now", "user_prompt": ""}
    ctx = analysis_agent.build_analysis_context(run, {}, metrics, [])
    text = json.dumps(ctx)
    for raw_ip in ("203.0.113.7", "192.0.2.10", "192.0.2.12", "192.0.2.13"):
        assert raw_ip not in text


# --- unit: output parser ----------------------------------------------------


def test_parse_analysis_output_coerces_to_schema():
    parsed = analysis_agent.parse_analysis_output("access_log_analysis", _access_log_output())
    # exactly the schema keys, nothing extra
    assert set(parsed) == set(analysis_agent.fields_for("access_log_analysis"))
    assert "should_be_dropped" not in parsed
    # list capped at SAMPLE_LIMIT
    assert len(parsed["key_observations"]) == guardrails.SAMPLE_LIMIT
    # CoT stripped + secret redacted in the text field
    assert "reasoning</thinking>" not in parsed["executive_summary"]
    assert ACCESS not in parsed["executive_summary"]


def test_parse_analysis_output_handles_json_string_and_garbage():
    parsed = analysis_agent.parse_analysis_output(
        "inventory_analysis", json.dumps(_inventory_output()))
    assert parsed["executive_summary"].startswith("Two large parquet")
    # non-JSON string still yields the full schema (empty fields)
    fallback = analysis_agent.parse_analysis_output("inventory_analysis", "not json at all")
    assert set(fallback) == set(analysis_agent.fields_for("inventory_analysis"))


def test_assert_no_secrets_blocks_unredacted_context():
    with pytest.raises(GuardrailBlocked):
        guardrails.assert_no_secrets_in_context({"x": f"{ACCESS}"})
