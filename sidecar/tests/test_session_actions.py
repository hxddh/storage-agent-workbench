"""Tests for Phase 17 next-action handoff.

Proposals are suggestions, never automation. preview/prepare only validate +
prefill — they never create a run, download evidence, confirm an import, call
S3, or call an LLM. These verify per-action-type behavior, the action_type
allowlist, needs_input cases, that nothing is auto-executed, that the assistant's
proposed_actions are sanitized/coerced and always require confirmation, and that
audit events are recorded.
"""

import json
import sqlite3

import pytest

from app import config, run_service
from app.agent_runtime import session_agent
from app.models.schemas import RunCreate
from app.repositories import account_discovery as account_repo
from app.repositories import runs as runs_repo
from app.repositories import sessions as sessions_repo

ACCESS = "AKIAIOSFODNN7EXAMPLE"
MODEL_KEY = "sk-MODEL-SECRET-DO-NOT-LEAK"


def _db():
    c = sqlite3.connect(str(config.db_path()))
    c.row_factory = sqlite3.Row
    return c


def _provider(client):
    return client.post("/cloud-providers", json={
        "name": "demo", "provider_type": "s3-compatible", "endpoint_url": "https://m",
        "region": "us-east-1", "addressing_style": "path", "access_key": ACCESS, "secret_key": "s"}).json()["id"]


def _session(client, provider_id=None, primary_bucket=None):
    return client.post("/sessions", json={
        "title": "Investigate", "goal": "diagnose",
        "provider_id": provider_id, "primary_bucket": primary_bucket}).json()


def _add_model_provider(client):
    client.post("/model-providers", json={
        "name": "openai", "provider_type": "openai", "base_url": "https://api.openai.com/v1",
        "model": "gpt-4o-mini", "api_key": MODEL_KEY})


def _seed_account_run(session_id, provider_id, *, inventory_buckets=(), logging_buckets=()):
    conn = _db()
    try:
        run_id = runs_repo.create(
            conn, RunCreate(run_type="account_discovery", provider_id=provider_id,
                            user_prompt="x", session_id=session_id), status="completed")
        sid = account_repo.create_snapshot(conn, run_id, provider_id, bucket_count=3, visible_count=3,
                                          processed_count=3, truncated=False, list_status="available", summary={})
        for b in set(inventory_buckets) | set(logging_buckets):
            account_repo.add_bucket(conn, sid, run_id, provider_id, b, "us-west-2", "available")
            account_repo.add_config_snapshot(conn, sid, run_id, provider_id, b, {"encryption_status": "available"})
            if b in inventory_buckets:
                account_repo.add_evidence_source(conn, sid, run_id, provider_id, b, {
                    "source_type": "inventory", "status": "available", "configured": True,
                    "configurations": [{"inventory_id": "inv1", "destination_bucket": "inv-dest",
                                        "destination_prefix": "inv/", "format": "CSV"}]})
            if b in logging_buckets:
                account_repo.add_evidence_source(conn, sid, run_id, provider_id, b, {
                    "source_type": "server_access_logging", "status": "available", "configured": True,
                    "target_bucket": "log-bucket", "target_prefix": "access/"})
        sessions_repo.link_run(conn, session_id, run_id, "account_discovery")
        conn.commit()
        return run_id
    finally:
        conn.close()


def _preview(client, sid, action_type, **proposal):
    return client.post(f"/sessions/{sid}/actions/preview", json={"proposal": {"action_type": action_type, **proposal}})


def _prepare(client, sid, action_type, **proposal):
    return client.post(f"/sessions/{sid}/actions/prepare", json={"proposal": {"action_type": action_type, **proposal}})


# --- preview / prepare per action type --------------------------------------


def test_preview_account_discovery(client):
    pid = _provider(client)
    s = _session(client, provider_id=pid)
    r = _preview(client, s["id"], "run_account_discovery").json()
    assert r["ready"] is True
    assert r["will_create"]["run_type"] == "account_discovery"
    assert r["proposal"]["requires_confirmation"] is True


def test_prepare_account_discovery_with_provider(client):
    pid = _provider(client)
    s = _session(client, provider_id=pid)
    r = _prepare(client, s["id"], "run_account_discovery").json()
    assert r["status"] == "ready" and r["open"] == "new_run"
    assert r["prefill"]["provider_id"] == pid and r["prefill"]["session_id"] == s["id"]


def test_prepare_account_discovery_missing_provider(client):
    s = _session(client)  # no provider
    r = _prepare(client, s["id"], "run_account_discovery").json()
    assert r["status"] == "needs_input" and "provider_id" in r["missing_inputs"]
    assert r["open"] is None


def test_prepare_bucket_config_review_missing_bucket(client):
    pid = _provider(client)
    s = _session(client, provider_id=pid)  # no primary_bucket
    r = _prepare(client, s["id"], "run_bucket_config_review").json()
    assert r["status"] == "needs_input" and "bucket" in r["missing_inputs"]


def test_prepare_diagnostic_with_session_bucket(client):
    pid = _provider(client)
    s = _session(client, provider_id=pid, primary_bucket="bucket-alpha")
    r = _prepare(client, s["id"], "run_diagnostic").json()
    assert r["status"] == "ready" and r["open"] == "new_run"
    assert r["prefill"]["bucket"] == "bucket-alpha" and r["prefill"]["run_type"] == "diagnostic"


def test_prepare_inventory_import_single_source(client):
    pid = _provider(client)
    s = _session(client, provider_id=pid)
    run_id = _seed_account_run(s["id"], pid, inventory_buckets=["data-bucket"])
    r = _prepare(client, s["id"], "plan_inventory_import").json()
    assert r["status"] == "ready" and r["open"] == "evidence_import"
    assert r["prefill"]["account_run_id"] == run_id
    assert r["prefill"]["bucket_name"] == "data-bucket"
    assert r["prefill"]["source_type"] == "inventory"


def test_prepare_inventory_import_multiple_sources_needs_input(client):
    pid = _provider(client)
    s = _session(client, provider_id=pid)
    _seed_account_run(s["id"], pid, inventory_buckets=["bucket-a", "bucket-b"])
    r = _prepare(client, s["id"], "plan_inventory_import").json()
    assert r["status"] == "needs_input" and "evidence_source" in r["missing_inputs"]
    cands = r["candidates"]["evidence_sources"]
    assert {c["bucket_name"] for c in cands} == {"bucket-a", "bucket-b"}


def test_prepare_access_log_import_does_not_autofill_time_range(client):
    pid = _provider(client)
    s = _session(client, provider_id=pid)
    _seed_account_run(s["id"], pid, logging_buckets=["data-bucket"])
    r = _prepare(client, s["id"], "plan_access_log_import").json()
    assert r["status"] == "ready" and r["open"] == "evidence_import"
    # time range must NOT be auto-filled — the planner requires it explicitly
    assert "time_range_start" not in r["prefill"] and "time_range_end" not in r["prefill"]
    assert any("time range" in n.lower() for n in r["safety_notes"])


def test_prepare_generate_session_report(client):
    s = _session(client)
    r = _prepare(client, s["id"], "generate_session_report").json()
    assert r["status"] == "ready" and r["open"] == "session_report"


def test_prepare_ask_user_for_context(client):
    s = _session(client)
    r = _prepare(client, s["id"], "ask_user_for_context", reason="need scope").json()
    assert r["status"] == "ready" and r["open"] == "message_composer"
    assert r["prefill"]["question"]


# --- no automatic execution -------------------------------------------------


def test_proposal_does_not_create_run(client):
    pid = _provider(client)
    s = _session(client, provider_id=pid, primary_bucket="b")
    before = len(client.get("/runs").json())
    _preview(client, s["id"], "run_diagnostic")
    _prepare(client, s["id"], "run_diagnostic")
    after = len(client.get("/runs").json())
    assert after == before  # nothing was created


def test_proposal_does_not_download_or_confirm_evidence(client):
    pid = _provider(client)
    s = _session(client, provider_id=pid)
    _seed_account_run(s["id"], pid, inventory_buckets=["data-bucket"])
    _prepare(client, s["id"], "plan_inventory_import")
    conn = _db()
    try:
        imports = conn.execute("SELECT count(*) FROM evidence_imports").fetchone()[0]
        datasets = conn.execute("SELECT count(*) FROM datasets").fetchone()[0]
    finally:
        conn.close()
    assert imports == 0 and datasets == 0  # no plan persisted, no download, no confirm


# --- allowlist / invalid handling -------------------------------------------


def test_free_form_action_accepted_but_forbidden_tokens_rejected(client):
    s = _session(client)
    # Free-form next steps are no longer capped to a fixed enum: a benign concrete
    # action is accepted and just routes to the conversational path (not ready,
    # nothing auto-creates).
    ok = client.post(f"/sessions/{s['id']}/actions/preview",
                     json={"proposal": {"action_type": "inspect_cors_config"}})
    assert ok.status_code == 200
    assert ok.json()["will_create"] is None
    # Defense in depth: a destructive/forbidden token is still rejected outright,
    # even though no destructive capability exists to execute it.
    bad = client.post(f"/sessions/{s['id']}/actions/preview",
                      json={"proposal": {"action_type": "run_shell_exec"}})
    assert bad.status_code == 422


def test_invalid_proposal_rejected_cleanly(client):
    s = _session(client)
    # Forbidden token, empty, and missing action_type are all rejected.
    for bad in ({"action_type": "shell"}, {"action_type": ""}, {}):
        r = client.post(f"/sessions/{s['id']}/actions/prepare", json={"proposal": bad})
        assert r.status_code == 422


# --- assistant proposed_actions ---------------------------------------------


def test_assistant_proposed_actions_sanitized_and_coerced(client, monkeypatch):
    s = _session(client)
    _add_model_provider(client)

    def fake_loop(spec):
        # Phase 19: unified contract uses "next_action_proposals".
        return (
            "Looks storage-side. <thinking>secret</thinking>\n"
            "```json\n"
            '{"answer": "Looks storage-side.", "next_action_proposals": ['
            f'{{"title": "Import logs {ACCESS}", "action_type": "plan_access_log_import", "confidence": "high"}},'
            '{"title": "wipe", "action_type": "exec_shell_wipe"}]}'
            "\n```"
        )

    monkeypatch.setattr(session_agent, "SESSION_LOOP", fake_loop)
    out = client.post(f"/sessions/{s['id']}/messages", json={"content": "client or storage?"}).json()
    actions = out["proposed_actions"]
    assert len(actions) == 1  # forbidden-token action_type ("exec"/"shell") dropped
    a = actions[0]
    assert a["action_type"] == "plan_access_log_import"
    assert a["requires_confirmation"] is True
    assert ACCESS not in a["title"]  # secret redacted
    # the stored assistant prose has no CoT and no json block
    assistant = [m for m in out["messages"] if m["role"] == "assistant"][-1]
    assert "secret" not in assistant["content"] and "next_action_proposals" not in assistant["content"]


# --- audit + schema ---------------------------------------------------------


def test_audit_events_recorded(client):
    pid = _provider(client)
    s = _session(client, provider_id=pid, primary_bucket="b")
    _preview(client, s["id"], "run_diagnostic")
    _prepare(client, s["id"], "run_diagnostic")
    conn = _db()
    try:
        events = {r[0] for r in conn.execute(
            "SELECT DISTINCT event_type FROM audit_logs WHERE event_type LIKE 'next_action_%'").fetchall()}
    finally:
        conn.close()
    assert {"next_action_previewed", "next_action_prepared", "next_action_opened"} <= events


def test_no_kanban_or_pm_tables(client):
    _session(client)
    conn = _db()
    try:
        names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    finally:
        conn.close()
    assert not (names & {"kanban", "boards", "tickets", "tasks", "assignees", "sprints", "columns"})


def test_existing_run_apis_unaffected(client, monkeypatch):
    monkeypatch.setattr(run_service, "start", run_service.run_sync)
    created = client.post("/runs", json={"run_type": "access_log_analysis", "user_prompt": "x"}).json()
    rid = created["run_id"]
    log = '2026-06-25T10:00:00Z b GET /p 200 10 5 ms user-agent="x" remote_ip="192.0.2.10"\n'
    client.post(f"/runs/{rid}/datasets/upload",
                files={"file": ("a.log", log.encode(), "text/plain")}, data={"dataset_type": "access_log"})
    client.post(f"/runs/{rid}/message", json={"content": "go"})
    detail = client.get(f"/runs/{rid}").json()
    assert detail["status"] == "completed" and detail["session_id"] is None
