"""v5: the one-shot v4 import, attached files, advice tools, compaction."""

from __future__ import annotations

import json
import sqlite3
import time

from app import config
from tests.fake_model import FakeModel, text_turn, tool_turn

_V4 = """
CREATE TABLE model_providers (id TEXT, name TEXT, provider_type TEXT, base_url TEXT, model TEXT, api_key_ref TEXT,
  created_at TEXT, updated_at TEXT, context_window INTEGER, max_output_tokens INTEGER, reasoning_effort TEXT);
CREATE TABLE cloud_providers (id TEXT, name TEXT, provider_type TEXT, endpoint_url TEXT, region TEXT,
  addressing_style TEXT, signature_version TEXT, access_key_ref TEXT, secret_key_ref TEXT, session_token_ref TEXT,
  mode TEXT, allowed_buckets_json TEXT, allowed_prefixes_json TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE sessions (id TEXT, title TEXT, goal TEXT, provider_id TEXT, primary_bucket TEXT, status TEXT,
  created_at TEXT, updated_at TEXT, pinned INTEGER, title_source TEXT);
CREATE TABLE session_messages (id TEXT, session_id TEXT, role TEXT, content TEXT, referenced_run_ids TEXT,
  referenced_evidence_ids TEXT, created_at TEXT, tool_activity TEXT, grounding TEXT, proposed_actions TEXT,
  turn_items TEXT, conclusion TEXT);
CREATE TABLE estate_buckets (provider_id TEXT, bucket TEXT, region TEXT, posture_json_sanitized TEXT,
  last_checked_at TEXT, source_run_id TEXT, source_task_id TEXT);
CREATE TABLE issues (id TEXT, provider_id TEXT, bucket TEXT, code TEXT, fingerprint TEXT, title TEXT, severity TEXT,
  status TEXT, detail_sanitized TEXT, first_seen_at TEXT, last_seen_at TEXT, resolved_at TEXT, resolved_by TEXT,
  source_task_id TEXT, source_run_id TEXT, fix_json_sanitized TEXT, last_verified_at TEXT, last_verify_result TEXT,
  created_at TEXT, updated_at TEXT);
CREATE TABLE issue_events (id INTEGER PRIMARY KEY, issue_id TEXT, kind TEXT, source TEXT, detail_json_sanitized TEXT,
  created_at TEXT);
CREATE TABLE watch_schedules (provider_id TEXT, enabled INTEGER, interval_hours INTEGER, next_run_at TEXT,
  last_run_at TEXT, last_status TEXT, last_summary_sanitized TEXT, last_run_id TEXT, last_task_id TEXT,
  created_at TEXT, updated_at TEXT);
CREATE TABLE storage_price_table (id TEXT, confirmed INTEGER, rates_json TEXT, note TEXT, updated_at TEXT);
"""
T = "2026-09-01T00:00:00Z"


def _legacy() -> None:
    old = sqlite3.connect(str(config.legacy_db_path()))
    old.executescript(_V4)
    old.execute("INSERT INTO model_providers VALUES ('m1','Local','llama.cpp','http://127.0.0.1:8080/v1','qwen',"
                "NULL,?,?,NULL,NULL,NULL)", (T, T))
    old.execute("INSERT INTO cloud_providers VALUES ('c1','prod','aws',NULL,'us-east-1','virtual','s3v4',"
                "'keyring://cloud_provider/c1/access_key','keyring://cloud_provider/c1/secret_key',NULL,'readonly',"
                "'[]','[]',?,?)", (T, T))
    old.execute("INSERT INTO sessions VALUES ('s1','Why 403',NULL,NULL,NULL,'active',?,?,0,'agent')", (T, T))
    old.execute("INSERT INTO session_messages VALUES ('u1','s1','user','Why do I get 403?',NULL,NULL,?,NULL,NULL,"
                "NULL,NULL,NULL)", (T,))
    old.execute("INSERT INTO session_messages VALUES ('a1','s1','assistant','Your policy denies it.',NULL,NULL,?,"
                "NULL,NULL,NULL,NULL,?)", (T, json.dumps({"answer": "Policy denies GetObject.", "findings": [],
                                                           "next_steps": []})))
    old.execute("INSERT INTO estate_buckets VALUES ('c1','www','us-east-1','{}',?,NULL,'s1')", (T,))
    old.execute("INSERT INTO issues VALUES ('i1','c1','www','public_exposure','fp1','Public','high','open',NULL,?,?,"
                "NULL,NULL,'s1',NULL,NULL,NULL,NULL,?,?)", (T, T, T, T))
    old.execute("INSERT INTO issue_events (issue_id, kind, source, created_at) VALUES ('i1','opened','survey',?)", (T,))
    old.execute("INSERT INTO watch_schedules VALUES ('c1',1,24,NULL,NULL,NULL,NULL,NULL,NULL,?,?)", (T, T))
    old.execute("INSERT INTO storage_price_table VALUES ('default',1,?, 'calibrated', ?)",
                (json.dumps({"storage_gb_month": {"STANDARD": 0.02}}), T))
    old.commit()
    old.close()


def test_the_v4_database_is_imported_once_and_never_modified(conn):
    from app import importer
    _legacy()
    before = config.legacy_db_path().read_bytes()
    counts = importer.run_once(conn)
    assert counts == {"model_providers": 1, "cloud_providers": 1, "tasks": 1, "buckets": 1, "issues": 1}
    assert importer.run_once(conn) is None  # once
    assert config.legacy_db_path().read_bytes() == before
    mp = conn.execute("SELECT kind, api_style, active FROM model_providers").fetchone()
    assert tuple(mp) == ("llamacpp", "chat", 1)
    from app.core import store
    task = store.get_task(conn, "s1")
    assert task["title"] == "Why 403" and task["title_source"] == "agent"
    types = [i["type"] for i in store.items_for_turns(conn, [t["id"] for t in store.branch(conn, "s1")])]
    assert types == ["user_message", "notice", "conclusion", "agent_message"]
    issue = conn.execute("SELECT status, source_task_id FROM issues WHERE id = 'i1'").fetchone()
    assert tuple(issue) == ("open", "s1")
    from app.analysis import prices
    assert prices.load(conn)["confirmed"] is True


def test_no_legacy_database_is_a_quiet_no_op(conn):
    from app import importer
    assert importer.run_once(conn) is None


_LOG = "\n".join(
    f'79a5 bucket [06/Feb/2026:00:00:{i:02d} +0000] 10.0.0.{i % 3} - REQ{i} REST.GET.OBJECT key{i % 4} '
    f'"GET /bucket/key{i % 4} HTTP/1.1" {200 if i % 5 else 403} - 1024 1024 10 5 "-" "curl/8" -'
    for i in range(40)) + "\n"


def test_an_attached_log_is_analyzed_without_rows_reaching_the_model(client):
    tid = client.post("/tasks", json={}).json()["task"]["id"]
    up = client.post(f"/tasks/{tid}/files", files={"file": ("access.log", _LOG.encode(), "text/plain")})
    assert up.status_code == 201, up.text
    ds = up.json()
    assert ds["type"] == "access_log" and ds["size_bytes"] == len(_LOG)
    with FakeModel([tool_turn("analyze_uploaded_file", {"dataset_id": ds["id"]}),
                    tool_turn("aggregate_uploaded_file", {"dataset_id": ds["id"], "metric": "count",
                                                          "group_by": "status_code", "limit": 5}),
                    text_turn("Most requests succeed; 403s are 20%.")]) as fake:
        client.post("/providers/models", json={"name": "f", "kind": "openai-compatible", "base_url": fake.base_url,
                                               "model": "fake-model"})
        client.post(f"/tasks/{tid}/turns", json={"direction": "Analyze my log", "attachments": [ds["id"]]})
        deadline = time.monotonic() + 30
        while client.get(f"/tasks/{tid}").json()["state"] in ("working", "queued") and time.monotonic() < deadline:
            time.sleep(0.05)
        snap = client.get(f"/tasks/{tid}").json()
    user = snap["items"][0]["payload"]
    assert user["attachments"][0]["dataset_id"] == ds["id"]
    outs = [i["payload"] for i in snap["items"] if i["type"] == "tool_output"]
    assert [o["ok"] for o in outs] == [True, True], outs
    sent = json.dumps(fake.requests)
    assert "REQ7" not in sent and "10.0.0.1 -" not in sent  # no raw row reached the model
    assert snap["files"][0]["status"] == "analyzed"


def test_import_evidence_refuses_an_undiscovered_source(client, conn):
    from app.engines import evidence
    try:
        evidence.import_source(conn, task_id="t", provider_id="p", bucket="b", source_type="inventory")
    except evidence.ImportRefused as exc:
        assert "survey" in str(exc)
    else:
        raise AssertionError("an undiscovered source must be refused")
    assert evidence._clamp(10_000, evidence.MAX_FILES) == 500
    assert evidence._clamp(None, evidence.MAX_BYTES) == 256 * 1024 * 1024


def test_triage_is_deterministic_and_redacts():
    from app.agent.tools import advice
    from app.agent.tools.registry import CallContext, TurnContext, _current
    import threading

    token = _current.set(CallContext(TurnContext("", "", threading.Event(), None), "c", "triage_error"))
    try:
        out = advice.triage_error("<Error><Code>AccessDenied</Code><RequestId>ABC123</RequestId></Error> "
                                  "aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY HTTP/1.1 403")
    finally:
        _current.reset(token)
    assert out["error_code"] == "AccessDenied" and out["http_status"] == 403
    assert out["candidate_causes"] and "wJalrXUtnFEMI" not in json.dumps(out)


def test_compaction_folds_old_turns_into_a_summary(client, monkeypatch):
    from app.agent import runtime
    monkeypatch.setattr(runtime, "_COMPACT_FRACTION", 0.0)  # every history is "near the window"
    with FakeModel([text_turn("A1."), text_turn("A2."), text_turn("A3."), text_turn("A4.")],
                   compaction="- The user asked three things; all answered.") as fake:
        client.post("/providers/models", json={"name": "f", "kind": "openai-compatible", "base_url": fake.base_url,
                                               "model": "fake-model"})
        tid = client.post("/tasks", json={"direction": "Q1"}).json()["task"]["id"]
        for q in ("Q2", "Q3", "Q4"):
            deadline = time.monotonic() + 20
            while client.get(f"/tasks/{tid}").json()["state"] in ("working", "queued") and time.monotonic() < deadline:
                time.sleep(0.05)
            client.post(f"/tasks/{tid}/turns", json={"direction": q})
        deadline = time.monotonic() + 20
        while client.get(f"/tasks/{tid}").json()["state"] in ("working", "queued") and time.monotonic() < deadline:
            time.sleep(0.05)
        snap = client.get(f"/tasks/{tid}").json()
    assert fake.compaction_requests
    assert any(i["type"] == "compaction" for i in snap["items"])
    last = json.dumps(fake.requests[-1]["messages"])
    assert "all answered" in last and "Q1" not in last and "Q4" in last
