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


from app import config, db, run_service
from app.agent_runtime import session_agent
from app.models.schemas import RunCreate
from app.repositories import account_discovery as account_repo
from app.repositories import runs as runs_repo
from app.repositories import sessions as sessions_repo
from tests.turns import post_message

ACCESS = "AKIAIOSFODNN7EXAMPLE"
MODEL_KEY = "sk-MODEL-SECRET-DO-NOT-LEAK"


def _db():
    c = db.serialized(sqlite3.connect(str(config.db_path())))
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


def test_assistant_answer_has_no_proposals_and_no_cot(client, monkeypatch):
    """v1.11: the model writes plain Markdown; nothing it says becomes a
    proposal, and hidden reasoning never persists."""
    s = _session(client)
    _add_model_provider(client)

    def fake_loop(spec):
        return ("Looks storage-side. <thinking>secret</thinking>\n"
                f"Next I would import the logs ({ACCESS}).")

    monkeypatch.setattr(session_agent, "SESSION_LOOP", fake_loop)
    out = post_message(client, s['id'], json={"content": "client or storage?"}).json()
    assert "proposed_actions" not in out
    assistant = [m for m in out["messages"] if m["role"] == "assistant"][-1]
    assert "secret" not in assistant["content"]
    assert ACCESS not in assistant["content"]  # secret redacted


# --- audit + schema ---------------------------------------------------------


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
