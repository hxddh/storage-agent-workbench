"""Agent-native uploaded-file analysis (de-ossification).

A file attached in a session is analyzed by the conversational agent as a tool
(session_analysis_tools), not by a fixed deterministic run. These verify the
session upload endpoint, the tools that list + analyze the upload, that a
generic (non-access-log) file is flagged rather than reported as empty HTTP
metrics, and that the message turn surfaces pending attachments to the agent.
"""

import json
import sqlite3

from app import config, run_service
from app.agent_runtime import session_agent, session_analysis_tools
from app.agent_runtime import autonomy  # noqa: F401 (kept parallel to other suites)

ACCESS_LOG_TEXT = (
    '2026-06-25T10:00:00Z bucket-alpha GET /a/p1.parquet 206 1048576 42 ms '
    'user-agent="aws-sdk/1.0" remote_ip="192.0.2.10"\n'
    '2026-06-25T10:00:02Z bucket-alpha GET /private/secret.txt 403 0 12 ms '
    'user-agent="curl/8" remote_ip="192.0.2.12"\n'
)
GENERIC_LOG_TEXT = (
    "2026-06-25 10:00:00 INFO starting up\n"
    "2026-06-25 10:00:01 ERROR connection reset by peer\n"
)


def _fake_function_tool(fn):
    fn.name = fn.__name__
    return fn


def _conn():
    c = sqlite3.connect(str(config.db_path()))
    c.row_factory = sqlite3.Row
    return c


def _upload(client, sid, name, content, dtype="access_log"):
    return client.post(
        f"/sessions/{sid}/datasets/upload",
        files={"file": (name, content.encode(), "text/plain")},
        data={"dataset_type": dtype},
    )


def test_session_dataset_upload(client):
    sid = client.post("/sessions", json={"title": "t", "goal": "g"}).json()["id"]
    r = _upload(client, sid, "a.log", ACCESS_LOG_TEXT)
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "uploaded" and body["dataset_type"] == "access_log"
    assert body["session_id"] == sid and body["dataset_id"]


def test_upload_rejects_bad_type(client):
    sid = client.post("/sessions", json={"title": "t", "goal": "g"}).json()["id"]
    r = _upload(client, sid, "a.log", ACCESS_LOG_TEXT, dtype="nonsense")
    assert r.status_code == 422


def test_analyze_uploaded_access_log_returns_aggregates(client):
    sid = client.post("/sessions", json={"title": "t", "goal": "g"}).json()["id"]
    did = _upload(client, sid, "a.log", ACCESS_LOG_TEXT).json()["dataset_id"]

    conn = _conn()
    try:
        tools = session_analysis_tools.build(conn, _fake_function_tool, sid, [])
        analyze = next(t for t in tools if t.name == "analyze_uploaded_file")
        out = json.loads(analyze(did))
    finally:
        conn.close()

    assert out["type"] == "access_log"
    assert out["detected_format"] == "text"
    assert out["row_count"] == 2
    assert out["metrics"]["total_requests"] == 2
    # Marked imported → no longer a pending attachment.
    conn = _conn()
    try:
        from app.repositories import session_datasets as sds
        assert sds.list_pending_for_session(conn, sid) == []
        assert sds.get(conn, did)["status"] == "imported"
    finally:
        conn.close()


def test_analyze_generic_log_is_flagged_not_reported_as_empty(client):
    sid = client.post("/sessions", json={"title": "t", "goal": "g"}).json()["id"]
    did = _upload(client, sid, "app.log", GENERIC_LOG_TEXT).json()["dataset_id"]

    conn = _conn()
    try:
        tools = session_analysis_tools.build(conn, _fake_function_tool, sid, [])
        analyze = next(t for t in tools if t.name == "analyze_uploaded_file")
        out = json.loads(analyze(did))
    finally:
        conn.close()

    assert out["detected_format"] == "unknown"
    assert out["row_count"] == 2  # ingested raw, no crash
    assert "note" in out and "not" in out["note"].lower()  # tells the agent it isn't an access log


def test_list_uploaded_files_tool(client):
    sid = client.post("/sessions", json={"title": "t", "goal": "g"}).json()["id"]
    _upload(client, sid, "a.log", ACCESS_LOG_TEXT)
    conn = _conn()
    try:
        tools = session_analysis_tools.build(conn, _fake_function_tool, sid, [])
        lst = next(t for t in tools if t.name == "list_uploaded_files")
        files = json.loads(lst())["files"]
    finally:
        conn.close()
    assert len(files) == 1 and files[0]["filename"] == "a.log"


def test_message_turn_surfaces_attachment_to_agent(client, monkeypatch):
    """A freshly uploaded file is handed to the agent as an attached_file in the
    prompt — the turn no longer creates a deterministic analysis run."""
    sid = client.post("/sessions", json={"title": "t", "goal": "g"}).json()["id"]
    client.post("/model-providers", json={
        "name": "openai", "provider_type": "openai", "base_url": "https://api.openai.com/v1",
        "model": "gpt-4o-mini", "api_key": "sk-test-not-real"})
    _upload(client, sid, "a.log", ACCESS_LOG_TEXT)

    captured = {}

    def fake_loop(spec):
        captured["prompt"] = spec["prompt"]
        return "ack"

    monkeypatch.setattr(session_agent, "SESSION_LOOP", fake_loop)
    r = client.post(f"/sessions/{sid}/messages", json={"content": "分析下", "turn_id": "t1"})
    assert r.status_code == 200
    assert "attached_files" in captured["prompt"]
    assert "a.log" in captured["prompt"]


def test_no_run_created_on_session_upload(client, monkeypatch):
    """Uploading to a session must NOT spawn a run (the old ossified path did)."""
    sid = client.post("/sessions", json={"title": "t", "goal": "g"}).json()["id"]
    _upload(client, sid, "a.log", ACCESS_LOG_TEXT)
    runs = client.get("/runs").json()
    assert runs == [] or all(r.get("run_type") != "access_log_analysis" for r in runs)
