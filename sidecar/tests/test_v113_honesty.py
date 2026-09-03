"""Honesty regressions (v1.13): export truth, routing truth, recovery truth.

Each test pins one v1.13 fix so it cannot silently regress: the OTel export
carries events + spans, unknown execution kinds are rejected, restart recovery
covers waiting executions, plural secret keys redact, optimization tools emit
full activity rows, compaction chains, token estimates cover CJK, capability
memories clear on a green probe, preview budgets bound without gating, and a
cancelled resume is labelled a retry.
"""

from __future__ import annotations

import json

from app import db
from app.agent_runtime import compaction, session_agent
from app.agent_runtime import session_optimization_tools
from app.agent_runtime import session_tools
from app.security.redaction import REDACTED, redact
from app.task_runtime import store as task_store

PRESIGNED_URL = ("https://bucket.s3.us-east-1.amazonaws.com/path/obj.bin"
                 "?X-Amz-Algorithm=AWS4-HMAC-SHA256"
                 "&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20200101%2Feu-west-1%2Fs3%2Faws4_request"
                 "&X-Amz-Date=20200101T000000Z&X-Amz-Expires=3600"
                 "&X-Amz-SignedHeaders=host&X-Amz-Signature=deadbeefcafe")


class _FT:
    def __call__(self, fn):
        fn.name = fn.__name__
        return fn


def _task(client, title="honesty"):
    r = client.post("/sessions", json={"title": title, "goal": "honesty"})
    assert r.status_code == 201, r.text
    return r.json()


def _add_model_provider(client):
    r = client.post("/model-providers", json={
        "name": "honesty", "provider_type": "openai-compatible",
        "base_url": "http://127.0.0.1:9/v1", "model": "honesty-model"})
    assert r.status_code in (200, 201), r.text


def _wait_settled(client, task_id, exec_id, timeout: float = 10.0):
    import time
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        cur = client.get(f"/agent-tasks/{task_id}/executions/{exec_id}").json()
        if cur.get("status") not in ("queued", "running"):
            return cur
        time.sleep(0.05)
    return cur


def _run_one_turn(client, monkeypatch, task_id, answer="Done.",
                  activity_extra: list | None = None):
    def fake_loop(spec):
        for rec in (activity_extra or []):
            spec["activity"].append(rec)
        return {"answer": answer, "skills_used": [], "skills_offered": [],
                "evidence_used": [], "evidence_gaps": [],
                "tool_activity": list(spec["activity"]), "turn_items": []}

    monkeypatch.setattr(session_agent, "SESSION_LOOP", fake_loop)
    r = client.post(f"/agent-tasks/{task_id}/executions",
                    json={"direction": "honesty probe"})
    assert r.status_code == 201, r.text
    exec_id = r.json()["execution"]["id"]
    assert _wait_settled(client, task_id, exec_id)["status"] == "completed"
    return exec_id


# --- OTel export -----------------------------------------------------------------


def test_otel_export_carries_events_and_spans(client, monkeypatch):
    task = _task(client)
    _add_model_provider(client)
    exec_id = _run_one_turn(
        client, monkeypatch, task["id"],
        activity_extra=[{"id": "c1", "tool": "list_buckets", "target": "p1",
                         "result": "2 buckets", "ok": True, "status": "completed",
                         "duration_ms": 12}])
    out = client.get(f"/agent-tasks/{task['id']}/export/otel").json()
    assert out["events"], "export must carry the durable event log (column regression)"
    assert any(e["execution_id"] == exec_id for e in out["events"])
    assert out.get("trace_id") and len(out["trace_id"]) == 32
    assert out.get("spans"), "export must project OTel spans"
    for span in out["spans"]:
        assert len(span["span_id"]) == 16
        assert span["traceparent"].startswith("00-") and span["traceparent"].endswith("-01")
        assert span["trace_id"] == out["trace_id"]
    tool_spans = [s for s in out["spans"] if s["name"] == "tool.completed"]
    assert tool_spans and tool_spans[0]["duration_ms"] == 12


def test_execution_events_page_serves_one_execution(client, monkeypatch):
    task = _task(client)
    _add_model_provider(client)
    exec_id = _run_one_turn(
        client, monkeypatch, task["id"],
        activity_extra=[{"id": "c9", "tool": "head_bucket", "target": "b",
                         "result": "200", "ok": True, "status": "completed"}])
    page = client.get(
        f"/agent-tasks/{task['id']}/executions/{exec_id}/events-page?after=0&limit=1000").json()
    assert page["events"], "per-execution page must serve the execution's rows"
    assert all(e["execution_id"] == exec_id for e in page["events"])
    assert any(e["event_type"] == "tool.completed" for e in page["events"])


# --- routing truth -----------------------------------------------------------------


def test_unknown_execution_kind_is_422(client):
    task = _task(client)
    _add_model_provider(client)
    r = client.post(f"/agent-tasks/{task['id']}/executions",
                    json={"direction": "x", "kind": "verfiy"})
    assert r.status_code == 422


# --- recovery truth -----------------------------------------------------------------


def test_recovery_stamps_waiting_interrupted_and_keeps_decision(client):
    from app.task_runtime import recovery, store
    task = _task(client)
    conn = db.connect()
    try:
        store.ensure_task(conn, task["id"], task["title"], task.get("goal"))
        execution = store.create_execution(conn, task["id"], "import it", "t-wait")
        store.set_execution_status(conn, execution["id"], store.EXEC_WAITING)
        decision = store.open_approval(conn, task["id"], execution["id"],
                                       "import_inventory", "Import 3 files",
                                       "moves bytes", {"impact": {"bucket": "b"}})
        conn.commit()
    finally:
        conn.close()
    assert recovery.reconcile_interrupted_executions() >= 1
    conn = db.connect()
    try:
        assert store.get_execution(conn, execution["id"])["status"] == store.EXEC_INTERRUPTED
        # The boundary stands: the pending Decision survives for Resume to re-raise.
        assert store.get_decision(conn, decision["id"])["status"] == store.DECISION_PENDING
    finally:
        conn.close()


def test_resume_of_cancelled_is_labelled_retry(client):
    # No worker is started on purpose: submit() would race the stop, so the
    # queued row is created directly for a deterministic cancel.
    from app.task_runtime import runtime, store
    task = _task(client)
    conn = db.connect()
    try:
        store.ensure_task(conn, task["id"], task["title"], task.get("goal"))
        execution = store.create_execution(conn, task["id"], "to cancel", "t-cancel")
        conn.commit()
        runtime.stop(conn, execution["id"])
        assert store.get_execution(conn, execution["id"])["status"] == store.EXEC_CANCELLED
        nxt = runtime.resume(conn, execution["id"])
        assert nxt["kind"] == "retry"
        assert "[retry]" in (nxt["direction"] or "")
    finally:
        conn.close()


# --- redaction -----------------------------------------------------------------


def test_redaction_covers_plural_secret_keys():
    for key in ("credentials", "tokens", "secrets", "passwords", "cookies", "signatures"):
        assert redact({key: "hunter2-value"})[key] == REDACTED
    assert redact({"credentials": "keyring://scope/name"})["credentials"] == "keyring://scope/name"


# --- activity shape -----------------------------------------------------------------


def test_optimization_tools_emit_full_activity_rows(client):
    task = _task(client)
    conn = db.connect()
    try:
        activity: list = []
        tools = {t.__name__: t for t in session_optimization_tools.build(
            conn, _FT(), task["id"], activity)}
        out = json.loads(tools["simulate_storage_cost"]())
        assert out["kind"] == "gap"  # no inventory in this task
        rows = [a for a in activity if a.get("tool") == "simulate_storage_cost"]
        assert len(rows) == 1
        row = rows[0]
        assert row.get("id") and row.get("ok") is True and row.get("status") == "completed"
    finally:
        conn.close()


# --- compaction -----------------------------------------------------------------


def test_compaction_chains_prior_summary(client, monkeypatch):
    task = _task(client)
    _add_model_provider(client)
    conn0 = db.connect()
    try:
        task_store.ensure_task(conn0, task["id"], task["title"], task.get("goal"))
        conn0.commit()
    finally:
        conn0.close()
    creds = {"api_key": "not-needed", "model": "chain-model", "base_url": None,
             "context_window": 8000}
    seen: list = []

    def fake_step(c, messages, prior):
        seen.append(prior)
        return "continued summary v%d" % (len(seen))

    monkeypatch.setattr(compaction, "COMPACT_STEP", fake_step)
    conn = db.connect()
    try:
        msgs = [{"role": "user", "content": "q%d" % i, "seq": i} for i in range(1, 6)]
        first = compaction.compact(conn, task["id"], creds, "e1", messages=msgs)
        assert first and first["version"] == 1
        conn.commit()
        assert seen == [None]
        msgs2 = msgs + [{"role": "user", "content": "q6", "seq": 6}]
        second = compaction.compact(conn, task["id"], creds, "e2", messages=msgs2)
        assert second and second["version"] == 2
        conn.commit()
        assert seen[1] == "continued summary v1"
        latest = task_store.latest_context(conn, task["id"])
        assert latest and latest["summary"] == "continued summary v2"
    finally:
        conn.close()


def test_estimate_tokens_weights_cjk():
    latin = "x" * 400
    cjk = "\u4e2d" * 100
    assert compaction.estimate_tokens(latin) == 100
    assert compaction.estimate_tokens(cjk) == 100
    assert compaction.estimate_tokens(cjk) > len(cjk) // 4


# --- capability memories -----------------------------------------------------------------


def test_forget_endpoint_capabilities_clears_refusals():
    session_agent._NO_USAGE_ENDPOINTS.add("http://127.0.0.1:9/v1|m")
    session_agent._NO_PARALLEL_ENDPOINTS.add("http://127.0.0.1:9/v1|m")
    session_agent._NO_CACHE_RETENTION_ENDPOINTS.add("http://127.0.0.1:9/v1|m")
    session_agent.forget_endpoint_capabilities("http://127.0.0.1:9/v1", "m")
    assert "http://127.0.0.1:9/v1|m" not in session_agent._NO_USAGE_ENDPOINTS
    assert "http://127.0.0.1:9/v1|m" not in session_agent._NO_PARALLEL_ENDPOINTS
    assert "http://127.0.0.1:9/v1|m" not in session_agent._NO_CACHE_RETENTION_ENDPOINTS


# --- preview budget is a bound, not a gate -----------------------------------------------------------------


def test_preview_budget_exhaustion_synthesizes_without_decision(client, monkeypatch):
    from botocore.exceptions import ClientError

    from app.s3 import client_factory

    def _denied(*a, **k):
        raise AssertionError("budget must stop before any 17th S3 call")

    task = _task(client)
    pid = client.post("/cloud-providers", json={
        "name": "prev", "provider_type": "s3-compatible",
        "endpoint_url": "https://minio.example.com", "region": "us-east-1",
        "addressing_style": "path"}).json()["id"]

    class _FakeClient:
        def get_object(self, **kwargs):
            raise ClientError({"Error": {"Code": "AccessDenied", "Message": "no"}},
                              "GetObject")

    monkeypatch.setattr(client_factory, "build_s3_client", lambda *a, **k: _FakeClient())
    conn = db.connect()
    try:
        activity: list = []
        tools = {t.name: t for t in session_tools.build(conn, _FT(), activity)}
        last = ""
        for i in range(17):
            if i == 16:
                monkeypatch.setattr(client_factory, "build_s3_client", _denied)
            last = tools["preview_object"](pid, "b", f"k{i}")
        assert "budget" in last and "used up" in last
        conn2 = db.connect()
        try:
            pending = conn2.execute(
                "SELECT count(*) FROM task_decisions WHERE task_id = ? AND status = 'pending'",
                (task["id"],)).fetchone()[0]
        finally:
            conn2.close()
        assert pending == 0, "an exhausted budget must not raise a Decision"
    finally:
        conn.close()
