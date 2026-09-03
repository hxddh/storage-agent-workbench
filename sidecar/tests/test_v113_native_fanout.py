"""Bounded single-agent fanout (v1.13): one survey row, sharded probes.

The product has no sub-agent fleet. ``survey_account`` fans its bucket shards
across ``_PROBE_WORKERS`` threads inside the deterministic survey executor,
sharing the turn's steer/budget, and merges as the ONE tool row the transcript
shows. These tests pin the bound and the merge — not the timing.
"""

from __future__ import annotations

import json

from app import db
from app.agent_runtime import session_action_tools
from app.models.schemas import RunCreate
from app.repositories import account_discovery as account_repo
from app.repositories import runs as runs_repo
from app.runs import account_discovery_run


def _stub_tool(fn):
    return fn


def test_probe_workers_stay_bounded():
    assert account_discovery_run._PROBE_WORKERS == 4


def test_survey_merges_shards_as_one_tool_row(client, monkeypatch):
    pid = client.post("/cloud-providers", json={
        "name": "fanout", "provider_type": "s3-compatible",
        "endpoint_url": "https://minio.example.com", "region": "us-east-1",
        "addressing_style": "path",
        "access_key": "AKIAIOSFODNN7EXAMPLE", "secret_key": "fanout-secret"}).json()["id"]
    task = client.post("/sessions", json={"title": "fanout", "goal": "survey"}).json()
    sid = task["id"]

    conn = db.connect()
    try:
        run_id = runs_repo.create(
            conn, RunCreate(run_type="account_discovery", provider_id=pid,
                            user_prompt="discover", session_id=sid), status="completed")
        account_repo.create_snapshot(
            conn, run_id, pid, bucket_count=5, visible_count=5,
            processed_count=5, truncated=False, list_status="available", summary={})
        conn.commit()
    finally:
        conn.close()

    monkeypatch.setattr(session_action_tools, "_execute_run", lambda *a, **k: run_id)

    conn2 = db.connect()
    try:
        activity: list = []
        tools = session_action_tools.build(conn2, _stub_tool, activity, sid, "t-fanout")
        survey = next(t for t in tools if getattr(t, "__name__", "") == "survey_account")
        out = json.loads(survey(pid))
    finally:
        conn2.close()

    assert out["status"] == "completed"
    assert out["fanout_workers"] == account_discovery_run._PROBE_WORKERS == 4
    assert out["bucket_count"] == 5
    # Exactly one completed row for the whole sharded survey — never one per shard.
    rows = [a for a in activity if a.get("tool") == "survey_account"
            and a.get("status") == "completed"]
    assert len(rows) == 1
