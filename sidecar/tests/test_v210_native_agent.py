"""v2.1.0 — native agent: no approval pause, no model plan, work continues itself.

- ``import_evidence`` runs inside the execution with no Decision, clamped to the
  autonomous envelope (500 files / 256 MiB), refused without disk headroom, and
  audited as ``approved_by=agent``;
- restart recovery continues each interrupted execution once (never a crash
  loop) and leaves it for a manual Resume when no model is usable.
"""

from __future__ import annotations

import time

from app.agent_runtime import import_tools, session_agent
from tests.test_v111_native_turns import _add_model_provider, _task


class _FT:
    def __call__(self, fn):
        fn.name = fn.__name__
        return fn


def _fake_import_service(monkeypatch, *, files=3, size=4096, warnings=()):
    from app.evidence import import_service
    calls: dict = {"confirm": [], "run": []}

    def plan(conn, **kw):
        calls["plan"] = kw
        return {"id": "imp1", "selected_file_count": files, "selected_total_bytes": size,
                "source_bucket": kw["bucket_name"], "source_prefix": "inv/",
                "warnings": list(warnings)}

    def confirm(conn, import_id, approved_by="user"):
        calls["confirm"].append(approved_by)
        return {}

    def run(conn, import_id, task_id=None):
        calls["run"].append(import_id)
        return {"downloaded_file_count": files, "downloaded_total_bytes": size,
                "analysis_run_id": "run-a"}

    monkeypatch.setattr(import_service, "plan", plan)
    monkeypatch.setattr(import_service, "confirm", confirm)
    monkeypatch.setattr(import_service, "run", run)
    monkeypatch.setattr(import_tools, "_latest_account_run", lambda conn, sid: "survey-1")
    return calls


def _import_tool(conn, task_id, activity):
    return import_tools.build(conn, _FT(), activity, task_id, "turn-1")[0]


def test_import_runs_without_a_decision_and_is_clamped_and_audited(client, monkeypatch):
    from app.db import connect
    task = _task(client)
    calls = _fake_import_service(monkeypatch, warnings=["Selection truncated to stay within "
                                                        "max_files / max_bytes."])
    activity: list = []
    conn = connect()
    try:
        tool = _import_tool(conn, task["id"], activity)
        t0 = time.monotonic()
        out = tool("inventory", "acme-inv", max_files=99999, max_bytes=10 ** 12)
        assert time.monotonic() - t0 < 2.0  # never waits on anyone
    finally:
        conn.close()
    assert out.startswith("status: imported")
    assert "coverage is partial" in out
    assert calls["plan"]["max_files"] == import_tools.AGENT_MAX_FILES == 500
    assert calls["plan"]["max_bytes"] == import_tools.AGENT_MAX_BYTES == 256 * 1024 * 1024
    assert calls["confirm"] == ["agent"] and calls["run"] == ["imp1"]
    assert activity[-1]["ok"] is True and "decision_id" not in activity[-1]
    assert client.get(f"/agent-tasks/{task['id']}/decisions").json()["decisions"] == []


def test_import_refuses_without_disk_headroom_and_downloads_nothing(client, monkeypatch):
    from app.db import connect
    task = _task(client)
    calls = _fake_import_service(monkeypatch)
    monkeypatch.setattr(import_tools, "_disk_ok", lambda needed: False)
    conn = connect()
    try:
        out = _import_tool(conn, task["id"], [])("access_log", "acme-logs",
                                                 time_range_start="2026-01-01",
                                                 time_range_end="2026-01-02")
    finally:
        conn.close()
    assert out.startswith("error: not enough free disk space")
    assert calls["confirm"] == [] and calls["run"] == []


def test_import_stops_before_download_when_the_execution_was_stopped(client, monkeypatch):
    import threading

    from app.db import connect
    task = _task(client)
    calls = _fake_import_service(monkeypatch)
    cancel = threading.Event()
    cancel.set()
    conn = connect()
    try:
        tool = import_tools.build(conn, _FT(), [], task["id"], "turn-1", cancel_event=cancel)[0]
        out = tool("inventory", "acme-inv")
    finally:
        conn.close()
    assert out.startswith("status: stopped")
    assert calls["run"] == []


def _interrupted(client, direction="long survey", turn="r1"):
    from app.db import connect
    from app.task_runtime import recovery, store
    task = _task(client)
    conn = connect()
    try:
        store.ensure_task(conn, task["id"])
        execution = store.create_execution(conn, task["id"], direction, turn)
        store.set_execution_status(conn, execution["id"], store.EXEC_RUNNING)
        conn.commit()
    finally:
        conn.close()
    assert recovery.reconcile_interrupted_executions() == [execution["id"]]
    return task, execution


def _executions(client, task_id):
    return client.get(f"/agent-tasks/{task_id}/executions").json()["executions"]


def test_recovery_continues_interrupted_work_once(client, monkeypatch):
    from app.task_runtime import recovery
    _add_model_provider(client)
    monkeypatch.setattr(session_agent, "SESSION_LOOP", lambda spec: {
        "answer": "Continued.", "skills_used": [], "skills_offered": [], "evidence_used": [],
        "evidence_gaps": [], "tool_activity": []})
    task, execution = _interrupted(client)
    assert recovery.resume_interrupted([execution["id"]]) == 1
    rows = _executions(client, task["id"])
    cont = rows[-1]
    assert cont["kind"] == "resume" and cont["resumed_from"] == execution["id"]
    assert "[resume]" in cont["direction"] and "long survey" in cont["direction"]
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        row = client.get(f"/agent-tasks/{task['id']}/executions/{cont['id']}").json()
        if row["status"] not in ("queued", "running"):
            break
        time.sleep(0.05)
    assert row["status"] == "completed"
    assert client.get(f"/agent-tasks/{task['id']}/state").json()["status"] == "ready"


def test_an_interrupted_continuation_is_not_resumed_again(client, monkeypatch):
    from app.db import connect
    from app.task_runtime import recovery, store
    _add_model_provider(client)
    task, execution = _interrupted(client)
    conn = connect()
    try:
        cont = store.create_execution(conn, task["id"], "long survey\n\n[resume] …", "r2",
                                      kind="resume", resumed_from=execution["id"])
        store.set_execution_status(conn, cont["id"], store.EXEC_RUNNING)
        conn.commit()
    finally:
        conn.close()
    ids = recovery.reconcile_interrupted_executions()
    assert ids == [cont["id"]]
    assert recovery.resume_interrupted(ids) == 0
    assert client.get(f"/agent-tasks/{task['id']}/state").json()["status"] == "needs_attention"


def test_without_a_model_recovery_leaves_a_manual_resume(client):
    from app.task_runtime import recovery
    task, execution = _interrupted(client)
    assert recovery.resume_interrupted([execution["id"]]) == 0
    assert [e["id"] for e in _executions(client, task["id"])] == [execution["id"]]
    assert client.get(f"/agent-tasks/{task['id']}/state").json()["status"] == "needs_attention"
