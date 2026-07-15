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


def _prepare(client, sid, action_type, **proposal):
    return client.post(f"/sessions/{sid}/actions/prepare", json={"proposal": {"action_type": action_type, **proposal}})


# --- preview / prepare per action type --------------------------------------


def test_run_proposals_route_conversationally_no_form(client):
    """Investigation/diagnosis/config/account/analysis proposals no longer open a
    'new_run' form — there is no form. prepare() leaves open=None so the UI hands
    the request back to the agent to do with its read-only tools."""
    pid = _provider(client)
    s = _session(client, provider_id=pid, primary_bucket="bucket-alpha")
    for at in ("run_account_discovery", "run_bucket_config_review", "run_diagnostic",
               "run_inventory_analysis", "run_access_log_analysis"):
        r = _prepare(client, s["id"], at).json()
        assert r["open"] is None, at
        assert r.get("will_create") in (None, {}), at
    # The proposal still normalizes + carries requires_confirmation.
    assert _prepare(client, s["id"], "run_account_discovery").json()["proposal"]["requires_confirmation"] is True


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


def test_null_title_reason_do_not_become_the_string_none(client):
    """A proposal with explicit null title/reason must NOT surface the literal
    'None' (str(None)). Regression: clicking such a proposal put 'None' in the
    composer."""
    s = _session(client)
    # title null → falls back to the action_type label, not "None"
    r = client.post(f"/sessions/{s['id']}/actions/prepare",
                    json={"proposal": {"action_type": "ask_user_for_context",
                                       "title": None, "reason": None}}).json()
    prop = r["proposal"]
    assert prop["title"] != "None" and prop["reason"] != "None"
    assert prop["title"] == "ask user for context"  # action_type label fallback
    assert prop["reason"] is None
    # the message-composer prefill is a real question, never "None"
    assert r["prefill"]["question"] and r["prefill"]["question"] != "None"


# --- no automatic execution -------------------------------------------------


def test_proposal_does_not_create_run(client):
    pid = _provider(client)
    s = _session(client, provider_id=pid, primary_bucket="b")
    before = len(client.get("/runs").json())
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
    ok = client.post(f"/sessions/{s['id']}/actions/prepare",
                     json={"proposal": {"action_type": "inspect_cors_config"}})
    assert ok.status_code == 200
    assert ok.json()["open"] is None  # routes back to the agent, opens no flow
    # Defense in depth: a destructive/forbidden token is still rejected outright,
    # even though no destructive capability exists to execute it.
    bad = client.post(f"/sessions/{s['id']}/actions/prepare",
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
    _prepare(client, s["id"], "generate_session_report")
    conn = _db()
    try:
        events = {r[0] for r in conn.execute(
            "SELECT DISTINCT event_type FROM audit_logs WHERE event_type LIKE 'next_action_%'").fetchall()}
    finally:
        conn.close()
    assert {"next_action_prepared", "next_action_opened"} <= events


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


# --- v0.26.0: query_account_profile (cross-bucket posture from persisted survey) ---


class _FT:
    def __call__(self, fn):
        fn.name = fn.__name__
        return fn


def _seed_survey_with_flags(session_id, provider_id, buckets):
    """buckets: list of (name, config_flags_dict). Persists one completed survey."""
    conn = _db()
    try:
        run_id = runs_repo.create(
            conn, RunCreate(run_type="account_discovery", provider_id=provider_id,
                            user_prompt="x", session_id=session_id), status="completed")
        sid = account_repo.create_snapshot(conn, run_id, provider_id, bucket_count=len(buckets),
                                           visible_count=len(buckets), processed_count=len(buckets),
                                           truncated=False, list_status="available", summary={})
        for name, flags in buckets:
            account_repo.add_bucket(conn, sid, run_id, provider_id, name, "us-east-1", "available")
            account_repo.add_config_snapshot(conn, sid, run_id, provider_id, name, flags)
        sessions_repo.link_run(conn, session_id, run_id, "account_discovery")
        conn.commit()
        return run_id
    finally:
        conn.close()


def _query_tool(conn):
    from app.agent_runtime import session_action_tools
    tools = {t.name: t for t in session_action_tools.build(conn, _FT(), [], session_id="s1")}
    return tools["query_account_profile"]


def test_query_account_profile_filters_by_posture(client):
    pid = _provider(client)
    sid = _session(client, provider_id=pid)["id"]
    _seed_survey_with_flags(sid, pid, [
        ("good", {"encryption_status": "available", "public_access_block_status": "available",
                  "lifecycle_status": "available"}),
        ("no-enc", {"encryption_status": "not_configured", "public_access_block_status": "available",
                    "lifecycle_status": "available"}),
        ("no-pab", {"encryption_status": "available", "public_access_block_status": "not_configured",
                    "lifecycle_status": "not_configured"}),
    ])
    conn = _db()
    try:
        tool = _query_tool(conn)
        allb = json.loads(tool(pid, "all"))
        assert allb["has_survey"] is True and allb["total_buckets"] == 3 and allb["matched_count"] == 3
        enc = json.loads(tool(pid, "missing_encryption"))
        assert [b["bucket"] for b in enc["buckets"]] == ["no-enc"]
        pab = json.loads(tool(pid, "missing_public_access_block"))
        assert [b["bucket"] for b in pab["buckets"]] == ["no-pab"]
        lc = json.loads(tool(pid, "missing_lifecycle"))
        assert [b["bucket"] for b in lc["buckets"]] == ["no-pab"]
        # Statuses only — no object keys/bodies leak into the matrix.
        blob = json.dumps(allb)
        assert "encryption_status" in blob and "Contents" not in blob
    finally:
        conn.close()


def test_query_account_profile_no_survey_and_bad_filter(client):
    pid = _provider(client)
    conn = _db()
    try:
        tool = _query_tool(conn)
        none = json.loads(tool(pid, "all"))
        assert none["has_survey"] is False and "survey_account" in none["note"]
        bad = json.loads(tool(pid, "bogus"))
        assert bad.get("error") and "filter" in bad["error"].lower()
    finally:
        conn.close()
