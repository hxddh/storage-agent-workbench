"""Tests for Phase 16 session workspace context.

Sessions link runs/evidence/findings, build a deterministic sanitized summary,
and expose an interpretation-only assistant (mocked LLM loop). These verify the
session CRUD + run linkage, that the summary excludes raw logs/rows/secrets and
is bounded, that findings reference their source run, that next actions are
proposals, that the assistant sees only sanitized context / fails cleanly with
no key / strips chain-of-thought / exposes no tools, that messages persist
sanitized, that the report is secret-free, and that no kanban/PM tables exist.
"""

import json
import sqlite3
import uuid
from typing import Any

import pytest

from app import config, run_service
from app.agent_runtime import session_agent
from app.repositories import sessions as sessions_repo
from app.s3 import client_factory

ACCESS = "AKIAIOSFODNN7EXAMPLE"
MODEL_KEY = "sk-MODEL-SECRET-DO-NOT-LEAK"
BEARER = "Bearer sk-LEAK-TOKEN-123"

ACCESS_LOG_JSONL = (
    json.dumps({"timestamp": "2026-06-25T11:00:00Z", "method": "GET", "path": "/a/b.txt",
                "status": 200, "bytes": 10, "user_agent": BEARER, "remote_ip": "203.0.113.7"}) + "\n"
    '2026-06-25T10:00:00Z bucket GET /p1 206 1048576 42 ms user-agent="aws-sdk/1.0" remote_ip="192.0.2.10"\n'
)


@pytest.fixture()
def sync_runs(monkeypatch):
    monkeypatch.setattr(run_service, "start", run_service.run_sync)


def _db():
    c = sqlite3.connect(str(config.db_path()))
    c.row_factory = sqlite3.Row
    return c


def _session(client, title="Customer A slow reads", goal="diagnose slow training reads"):
    return client.post("/sessions", json={"title": title, "goal": goal}).json()


def _add_model_provider(client):
    client.post("/model-providers", json={
        "name": "openai", "provider_type": "openai", "base_url": "https://api.openai.com/v1",
        "model": "gpt-4o-mini", "api_key": MODEL_KEY})


def _run_access_log_in_session(client, session_id, content=ACCESS_LOG_JSONL):
    created = client.post("/runs", json={
        "run_type": "access_log_analysis", "user_prompt": "analyze", "session_id": session_id}).json()
    rid = created["run_id"]
    client.post(f"/runs/{rid}/datasets/upload",
                files={"file": ("a.jsonl", content.encode(), "text/plain")},
                data={"dataset_type": "access_log"})
    client.post(f"/runs/{rid}/message", json={"content": "go"})
    return rid


# --- session CRUD + linkage -------------------------------------------------


def test_create_and_get_session(client):
    s = _session(client)
    assert s["status"] == "active" and s["title"]
    got = client.get(f"/sessions/{s['id']}").json()
    assert got["id"] == s["id"]
    assert client.get(f"/sessions/{s['id']}/messages").json()["messages"] == []


def test_list_sessions(client):
    _session(client, title="S1")
    _session(client, title="S2")
    rows = client.get("/sessions").json()
    assert len({r["id"] for r in rows}) >= 2
    assert all("run_count" in r and "finding_count" in r for r in rows)


def test_attach_existing_run_to_session(client, sync_runs):
    s = _session(client)
    # a standalone run (no session)
    created = client.post("/runs", json={"run_type": "access_log_analysis", "user_prompt": "x"}).json()
    rid = created["run_id"]
    client.post(f"/runs/{rid}/datasets/upload",
                files={"file": ("a.jsonl", ACCESS_LOG_JSONL.encode(), "text/plain")},
                data={"dataset_type": "access_log"})
    client.post(f"/runs/{rid}/message", json={"content": "go"})
    # attach after the fact
    detail = client.post(f"/sessions/{s['id']}/runs/{rid}").json()
    assert any(r["run_id"] == rid for r in detail["runs"])


def test_create_run_with_session_id_links_and_shows_in_run_detail(client, sync_runs):
    s = _session(client)
    rid = _run_access_log_in_session(client, s["id"])
    run_detail = client.get(f"/runs/{rid}").json()
    assert run_detail["session_id"] == s["id"]
    assert run_detail["session_title"] == s["title"]
    sess = client.get(f"/sessions/{s['id']}").json()
    assert any(r["run_id"] == rid for r in sess["runs"])


def test_run_completion_updates_session_summary(client, sync_runs):
    s = _session(client)
    _run_access_log_in_session(client, s["id"])
    summary = client.get(f"/sessions/{s['id']}/summary").json()
    assert summary["known_facts"], "expected at least one fact from the completed run"
    assert any(f.get("source_run_id") for f in summary["known_facts"])


def test_summary_excludes_raw_logs_and_secrets(client, sync_runs):
    s = _session(client)
    _run_access_log_in_session(client, s["id"])
    blob = json.dumps(client.get(f"/sessions/{s['id']}/summary").json())
    report = client.get(f"/sessions/{s['id']}/report").json()["content"]
    for needle in ("sk-LEAK-TOKEN-123", "203.0.113.7", "192.0.2.10", ACCESS):
        assert needle not in blob
        assert needle not in report


# --- findings: source_run_id, bounded ---------------------------------------


def _insert_completed_run_with_findings(session_id: str, n_findings: int) -> str:
    conn = _db()
    try:
        rid = uuid.uuid4().hex
        conn.execute(
            "INSERT INTO runs (id, run_type, title, status, planner_mode, final_summary, created_at, updated_at, session_id) "
            "VALUES (?, 'bucket_config_review', 'cfg', 'completed', 'deterministic', 'reviewed', datetime('now'), datetime('now'), ?)",
            (rid, session_id))
        findings = [{"category": "Warning", "severity": "Warning", "title": f"f{i}", "detail": "d"} for i in range(n_findings)]
        conn.execute(
            "INSERT INTO tool_calls (id, run_id, tool_name, input_json_sanitized, output_json_sanitized, status, duration_ms, created_at) "
            "VALUES (?, ?, 'review_bucket_security', '{}', ?, 'success', 1, datetime('now'))",
            (uuid.uuid4().hex, rid, json.dumps({"success": True, "findings": findings})))
        sessions_repo.link_run(conn, session_id, rid, "config_review")
        conn.commit()
        return rid
    finally:
        conn.close()


def test_session_finding_references_source_run_id(client):
    s = _session(client)
    rid = _insert_completed_run_with_findings(s["id"], 3)
    client.post(f"/sessions/{s['id']}/refresh-summary")
    detail = client.get(f"/sessions/{s['id']}").json()
    assert detail["findings"]
    assert all(f["source_run_id"] == rid for f in detail["findings"])


def test_session_summary_bounds_findings(client):
    s = _session(client)
    _insert_completed_run_with_findings(s["id"], 60)  # one run, 60 findings
    client.post(f"/sessions/{s['id']}/refresh-summary")
    detail = client.get(f"/sessions/{s['id']}").json()
    # per-run cap is 20; the session never stores the full 60
    assert 0 < len(detail["findings"]) <= 20


def test_next_actions_are_proposals_only(client, sync_runs):
    s = _session(client)
    _run_access_log_in_session(client, s["id"])
    summary = client.get(f"/sessions/{s['id']}/summary").json()
    assert summary["next_actions"]
    for a in summary["next_actions"]:
        assert a["requires_confirmation"] is True
        assert a["action_type"] in {
            "run_account_discovery", "run_bucket_config_review", "plan_inventory_import",
            "plan_access_log_import", "run_inventory_analysis", "run_access_log_analysis",
            "run_diagnostic", "generate_session_report", "ask_user_for_context"}


# --- session assistant (interpretation-only, mocked loop) -------------------


def test_assistant_sanitized_context_no_tools_and_cot_stripped(client, sync_runs, monkeypatch):
    s = _session(client)
    _run_access_log_in_session(client, s["id"])
    _add_model_provider(client)

    captured = {}

    def fake_loop(spec):
        captured["spec"] = spec
        return "Looks storage-side. <thinking>secret reasoning here</thinking>"

    monkeypatch.setattr(session_agent, "SESSION_LOOP", fake_loop)
    out = client.post(f"/sessions/{s['id']}/messages", json={"content": "client or storage problem?"})
    assert out.status_code == 200
    msgs = out.json()["messages"]
    assistant = [m for m in msgs if m["role"] == "assistant"][-1]
    assert "secret reasoning" not in assistant["content"]  # CoT stripped
    assert MODEL_KEY not in json.dumps(out.json())

    spec = captured["spec"]
    # interpretation-only: no tools/invoker handed to the model
    assert "invoker" not in spec and "tools" not in spec and "tool_names" not in spec
    # context carries only sanitized aggregates
    ctx = spec["context"]
    assert "summary" in ctx and "safety_rules" in ctx
    assert MODEL_KEY not in json.dumps(ctx)
    assert "sk-LEAK-TOKEN-123" not in json.dumps(ctx)


def test_assistant_missing_model_key_clean_failure(client, sync_runs):
    s = _session(client)
    _run_access_log_in_session(client, s["id"])
    # no model provider configured
    r = client.post(f"/sessions/{s['id']}/messages", json={"content": "status?"})
    assert r.status_code == 422
    assert "model provider" in r.json()["detail"].lower()
    # user message kept; deterministic summary still works
    msgs = client.get(f"/sessions/{s['id']}/messages").json()["messages"]
    assert any(m["role"] == "user" for m in msgs)
    assert not any(m["role"] == "assistant" for m in msgs)
    assert client.get(f"/sessions/{s['id']}/summary").json()["known_facts"]


def test_messages_persist_sanitized_content(client, monkeypatch):
    s = _session(client)
    _add_model_provider(client)
    monkeypatch.setattr(session_agent, "SESSION_LOOP", lambda spec: "ack")
    # user message contains a secret-shaped value -> must be redacted at rest
    client.post(f"/sessions/{s['id']}/messages", json={"content": f"my key is {ACCESS} ok"})
    msgs = client.get(f"/sessions/{s['id']}/messages").json()["messages"]
    user_msg = [m for m in msgs if m["role"] == "user"][-1]
    assert ACCESS not in user_msg["content"]


# --- report -----------------------------------------------------------------


def test_session_report_has_evidence_refs_and_no_secrets(client, sync_runs):
    s = _session(client)
    rid = _run_access_log_in_session(client, s["id"])
    report = client.get(f"/sessions/{s['id']}/report").json()["content"]
    assert "# Session Report" in report
    assert rid[:8] in report  # linked run referenced
    assert ACCESS not in report and MODEL_KEY not in report


# --- guardrails: schema shape + existing APIs -------------------------------


def test_no_kanban_or_project_management_tables(client):
    _session(client)  # ensure migrations applied
    conn = _db()
    try:
        names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    finally:
        conn.close()
    forbidden = {"kanban", "boards", "board", "columns", "tickets", "ticket", "tasks",
                 "task", "assignees", "assignee", "sprints", "epics"}
    assert not (names & forbidden), f"unexpected PM/kanban tables: {names & forbidden}"


def test_existing_run_apis_unaffected(client, sync_runs):
    # A run with no session_id still works exactly as before.
    created = client.post("/runs", json={"run_type": "access_log_analysis", "user_prompt": "x"}).json()
    rid = created["run_id"]
    client.post(f"/runs/{rid}/datasets/upload",
                files={"file": ("a.jsonl", ACCESS_LOG_JSONL.encode(), "text/plain")},
                data={"dataset_type": "access_log"})
    client.post(f"/runs/{rid}/message", json={"content": "go"})
    detail = client.get(f"/runs/{rid}").json()
    assert detail["status"] == "completed"
    assert detail["session_id"] is None
