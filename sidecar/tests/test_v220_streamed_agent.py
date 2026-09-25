"""v2.2.0 — native agent depth, pinned on the STREAMED path production runs.

Every test here drives a real Execution through the task runtime, the OpenAI
Agents SDK and a local OpenAI-compatible endpoint (``tests/fake_model.py``) —
no ``SESSION_LOOP`` / ``answer()`` seam. What they pin:

- every tool is callable from the first step (no ``load_tools`` round-trip);
  only a small-window model (≤ 16k) keeps the grouped disclosure, decided by
  the runtime;
- the Direction is durable from the moment its execution starts, in the user's
  words;
- a continuation answers under the same Direction and receives a bounded
  digest of the calls that already completed, instead of starting over;
- the survey and the evidence import report real progress as durable,
  throttled ``tool.progress`` events, and Stop ends an import between files.
"""

from __future__ import annotations

import threading
import time
from pathlib import Path

from app.agent_runtime import prompt
from app.task_runtime import continuation, runtime, store

from .fake_model import FakeModel, commentary_tool_turn, text_turn


def _provider(client, model, **extra):
    r = client.post("/model-providers", json={
        "name": "fake", "provider_type": "openai-compatible", "base_url": model.base_url,
        "model": "fake-model", "api_key": "not-a-real-key", **extra})
    assert r.status_code in (200, 201), r.text


def _task(client, title="acme-logs 403"):
    return client.post("/sessions", json={"title": title, "goal": None}).json()


def _submit(client, task_id, direction, turn_id):
    r = client.post(f"/agent-tasks/{task_id}/executions",
                    json={"direction": direction, "turn_id": turn_id})
    assert r.status_code == 201, r.text
    return r.json()["execution"]


def _settled(client, task_id, exec_id, timeout=15.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        row = client.get(f"/agent-tasks/{task_id}/executions/{exec_id}").json()
        if row["status"] not in ("queued", "running"):
            return row
        time.sleep(0.05)
    raise AssertionError("execution never settled")


def _messages(client, task_id):
    return client.get(f"/sessions/{task_id}/messages").json()["messages"]


def _tool_names(request: dict) -> set[str]:
    return {t.get("function", {}).get("name") for t in request.get("tools") or []}


def _system_text(request: dict) -> str:
    return " ".join(str(m.get("content") or "") for m in request.get("messages") or []
                    if m.get("role") in ("system", "developer"))


def _user_text(request: dict) -> str:
    return " ".join(str(m.get("content") or "") for m in request.get("messages") or []
                    if m.get("role") == "user")


# --- every tool from the first step --------------------------------------------


def test_every_tool_is_offered_from_the_first_step(client):
    with FakeModel([text_turn("Checked.")]) as model:
        _provider(client, model)
        task = _task(client)
        row = _settled(client, task["id"], _submit(client, task["id"], "check acme", "t1")["id"])
    assert row["status"] == "completed"
    names = _tool_names(model.requests[0])
    for tool in ("import_evidence", "survey_account", "get_object_acl",
                 "review_bucket_security", "list_object_versions", "measure_request_latency",
                 "aggregate_uploaded_file", "record_conclusion", "read_skill"):
        assert tool in names, tool
    assert "load_tools" not in names
    system = _system_text(model.requests[0])
    assert "load_tools" not in system
    assert "Every tool is callable from your first step" in system


def test_a_small_window_model_keeps_the_grouped_disclosure(client):
    with FakeModel([text_turn("Checked.")]) as model:
        _provider(client, model, context_window=8192)
        task = _task(client)
        row = _settled(client, task["id"], _submit(client, task["id"], "check acme", "t1")["id"])
    assert row["status"] == "completed"
    names = _tool_names(model.requests[0])
    assert "load_tools" in names
    assert "get_object_acl" not in names and "import_evidence" not in names
    assert "load_tools(group)" in _system_text(model.requests[0])


def test_the_two_instruction_texts_differ_only_in_the_tools_paragraph():
    assert prompt.INSTRUCTIONS_GATED.replace(
        prompt._TOOLS_PARAGRAPH_GATED, prompt._TOOLS_PARAGRAPH) == prompt.INSTRUCTIONS


def test_the_real_segmenter_persists_commentary_then_the_tool_row(client):
    with FakeModel([commentary_tool_turn("Reading the IAM policy skill first.", "read_skill",
                                         {"name": "storageops-security-iam-policy"}),
                    text_turn("The policy omits s3:ListBucket.")]) as model:
        _provider(client, model)
        task = _task(client)
        row = _settled(client, task["id"], _submit(client, task["id"], "why 403?", "t1")["id"])
    assert row["status"] == "completed"
    assistant = [m for m in _messages(client, task["id"]) if m["role"] == "assistant"][-1]
    kinds = [item["kind"] for item in assistant["turn_items"]]
    assert kinds == ["message", "tool"]
    assert assistant["turn_items"][0]["text"] == "Reading the IAM policy skill first."
    assert [a["tool"] for a in assistant["tool_activity"]] == ["read_skill"]
    assert assistant["content"] == "The policy omits s3:ListBucket."


# --- the Direction is durable from the start -----------------------------------


def test_the_direction_is_durable_while_the_execution_runs(client):
    with FakeModel([text_turn("A long answer " * 40, chunk_size=8)], delay_s=0.02) as model:
        _provider(client, model)
        task = _task(client)
        execution = _submit(client, task["id"], "why does acme-logs deny list?", "t1")
        deadline = time.monotonic() + 10
        seen_running = None
        while time.monotonic() < deadline:
            row = client.get(f"/agent-tasks/{task['id']}/executions/{execution['id']}").json()
            msgs = _messages(client, task["id"])
            if row["status"] == "running" and msgs:
                seen_running = msgs
                break
            time.sleep(0.02)
        assert seen_running, "the Direction was not durable while the execution ran"
        assert [m["role"] for m in seen_running] == ["user"]
        assert seen_running[0]["content"] == "why does acme-logs deny list?"
        _settled(client, task["id"], execution["id"])
    msgs = _messages(client, task["id"])
    assert [m["role"] for m in msgs] == ["user", "assistant"]
    events = client.get(f"/agent-tasks/{task['id']}/executions/{execution['id']}/events",
                        params={"deltas": "false"}).text
    assert "event: direction.recorded" in events
    # The prompt carried the Direction once, as the user's message.
    assert _user_text(model.requests[0]).count("why does acme-logs deny list?") == 1


def test_a_failed_execution_takes_back_its_unanswered_direction(client):
    from app.task_runtime import runtime as rt
    from app.db import connect
    task = _task(client)
    conn = connect()
    try:
        store.ensure_task(conn, task["id"])
        execution = store.create_execution(conn, task["id"], "why 403?", "f1")
        mid = rt._record_direction(conn, execution)
        conn.commit()
        rt._fail(conn, execution["id"], task["id"], "provider error")
    finally:
        conn.close()
    assert all(m["id"] != mid for m in _messages(client, task["id"]))
    row = client.get(f"/agent-tasks/{task['id']}/executions/{execution['id']}").json()
    assert row["status"] == "failed" and row["direction"] == "why 403?"
    page = client.get(f"/agent-tasks/{task['id']}/executions/{execution['id']}/events-page").json()
    assert "direction.withdrawn" in [e["event_type"] for e in page["events"]]


# --- a continuation picks up where it stopped ----------------------------------


def _interrupted_with_calls(client, task_id, direction="survey the account"):
    from app.db import connect
    from app.task_runtime import recovery
    conn = connect()
    try:
        store.ensure_task(conn, task_id)
        execution = store.create_execution(conn, task_id, direction, "r1")
        store.set_execution_status(conn, execution["id"], store.EXEC_RUNNING)
        runtime._record_direction(conn, store.get_execution(conn, execution["id"]))
        for i, (tool, target, result) in enumerate([
                ("list_buckets", "prod", "24 buckets"),
                ("head_bucket", "acme-logs", "403"),
                ("get_bucket_config_summary", "acme-logs", "policy omits s3:ListBucket")]):
            store.append_event(conn, execution["id"], task_id, "tool.completed", {
                "id": f"c{i}", "tool": tool, "target": target, "result": result, "ok": True})
        conn.commit()
    finally:
        conn.close()
    assert recovery.reconcile_interrupted_executions() == [execution["id"]]
    return execution


def test_an_interrupted_execution_continues_under_its_direction_with_a_digest(client):
    from app.task_runtime import recovery
    with FakeModel([text_turn("Continued from the digest.")]) as model:
        _provider(client, model)
        task = _task(client)
        execution = _interrupted_with_calls(client, task["id"])
        assert recovery.resume_interrupted([execution["id"]]) == 1
        rows = client.get(f"/agent-tasks/{task['id']}/executions").json()["executions"]
        cont = rows[-1]
        assert cont["kind"] == "resume" and cont["resumed_from"] == execution["id"]
        assert cont["direction"] == "survey the account"
        assert _settled(client, task["id"], cont["id"])["status"] == "completed"
    user = _user_text(model.requests[0])
    assert "[resume] The previous execution of this direction was interrupted" in user
    assert "- list_buckets prod → 24 buckets" in user
    assert "- get_bucket_config_summary acme-logs → policy omits s3:ListBucket" in user
    # One Direction heading in the user's words, answered once.
    msgs = _messages(client, task["id"])
    assert [(m["role"], m["content"]) for m in msgs] == [
        ("user", "survey the account"), ("assistant", "Continued from the digest.")]


def test_a_continuation_after_later_work_gets_its_own_clean_direction(client):
    from app.db import connect
    task = _task(client)
    execution = _interrupted_with_calls(client, task["id"])
    conn = connect()
    try:
        from app.repositories import sessions as sessions_repo
        sessions_repo.add_message(conn, task["id"], "user", "a later question")
        sessions_repo.add_message(conn, task["id"], "assistant", "a later answer")
        conn.commit()
        cont = store.create_execution(conn, task["id"], "survey the account", "r2",
                                      kind="resume", resumed_from=execution["id"])
        mid = runtime._record_direction(conn, cont)
        conn.commit()
    finally:
        conn.close()
    msgs = _messages(client, task["id"])
    assert msgs[-1]["id"] == mid and msgs[-1]["content"] == "survey the account"


def test_the_digest_is_bounded_and_follows_the_chain(client):
    from app.db import connect
    task = _task(client)
    conn = connect()
    try:
        store.ensure_task(conn, task["id"])
        first = store.create_execution(conn, task["id"], "d", "a1")
        for i in range(40):
            store.append_event(conn, first["id"], task["id"], "tool.completed", {
                "id": f"x{i}", "tool": "head_object", "target": f"k{i}",
                "result": "x" * 500, "ok": i % 2 == 0})
        second = store.create_execution(conn, task["id"], "d", "a2", kind="resume",
                                        resumed_from=first["id"])
        store.append_event(conn, second["id"], task["id"], "tool.completed", {
            "id": "y", "tool": "list_buckets", "target": "prod", "result": "3", "ok": True})
        conn.commit()
        digest = continuation.completed_calls_digest(conn, second["id"])
    finally:
        conn.close()
    lines = digest.splitlines()
    assert lines[0].startswith("- … ") and "not listed" in lines[0]
    assert lines[-1] == "- list_buckets prod → 3"
    assert len(lines) <= continuation._MAX_LINES + 1
    assert len(digest) <= continuation._MAX_DIGEST
    assert any("(failed)" in line for line in lines)


def test_a_legacy_note_is_never_shown_as_the_users_words():
    legacy = ("check it\n\n[resume] The previous execution of this direction was "
              "interrupted before it could finish. Continue from what the task has "
              "already established; do not start over.")
    assert continuation.clean_direction(legacy) == "check it"
    assert continuation.clean_direction("plain [resume] text") == "plain [resume] text"


# --- live progress ---------------------------------------------------------------


def _progress_events(client, task_id, exec_id):
    from app.db import connect
    conn = connect()
    try:
        return [e["payload"] for e in store.list_events(conn, exec_id)
                if e["event_type"] == "tool.progress"]
    finally:
        conn.close()


def test_progress_is_durable_throttled_and_keeps_the_last_report(client):
    from app.db import connect
    task = _task(client)
    conn = connect()
    try:
        store.ensure_task(conn, task["id"])
        execution = store.create_execution(conn, task["id"], "d", "p1")
        conn.commit()
    finally:
        conn.close()
    sink = runtime._progress_sink(execution["id"], task["id"])
    for done in range(0, 501):
        sink("call-1", "survey_account", done, 500, "buckets")
    events = _progress_events(client, task["id"], execution["id"])
    assert 1 <= len(events) <= 3  # a burst writes the first and the final report
    assert events[0]["done"] == 0
    assert events[-1] == {"id": "call-1", "tool": "survey_account", "done": 500,
                          "total": 500, "unit": "buckets"}


def test_the_survey_engine_reports_each_finished_bucket(monkeypatch):
    from app import progress
    from app.runs import account_discovery_run as adr
    monkeypatch.setattr(adr.account_tools, "get_bucket_config_snapshot",
                        lambda conn, pid, name: {"name": name})
    monkeypatch.setattr(adr.account_tools, "discover_evidence_sources",
                        lambda conn, pid, name, pre_reads=None: [])
    seen: list[tuple[int, int, str]] = []
    lock = threading.Lock()

    def on(done, total, unit):
        with lock:
            seen.append((done, total, unit))
    progress.bind("run-x", on)
    try:
        adr._probe_buckets("prov", [f"b{i}" for i in range(9)], "run-x")
    finally:
        progress.unbind("run-x")
    assert seen[0] == (0, 9, "buckets")
    assert sorted(d for d, _, _ in seen[1:]) == list(range(1, 10))
    assert all(t == 9 and u == "buckets" for _, t, u in seen)


def test_the_import_reports_files_and_stops_between_them(monkeypatch, tmp_path):
    from app.evidence import managed_import as mi
    monkeypatch.setattr(mi.client_factory, "build_s3_client", lambda conn, pid: object())
    stop = threading.Event()
    reports: list[tuple[int, int, str]] = []

    def fake_stream(client, bucket, key, dest: Path, cap):
        dest.write_bytes(b"line\n")
        if key == "k2":
            stop.set()  # the user presses Stop while the third file downloads
        return 5

    monkeypatch.setattr(mi, "_stream_object_to_file", fake_stream)
    files = [{"object_key": f"k{i}", "size": 5} for i in range(6)]
    try:
        mi.download_and_combine(None, "prov", "access_log", "bkt", None, None, files,
                                500, 1 << 20, tmp_path / "raw",
                                on_file=lambda d, t, u: reports.append((d, t, u)),
                                cancel_event=stop)
    except mi.ImportStopped:
        pass
    else:
        raise AssertionError("a stopped import must not complete")
    assert reports == [(0, 6, "files"), (1, 6, "files"), (2, 6, "files"), (3, 6, "files")]
    assert not (tmp_path / "raw" / "parts").exists()

