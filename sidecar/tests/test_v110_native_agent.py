"""v1.10.0 — native agent runtime additions.

Migration 028 (task title source, per-provider reasoning effort), the
reasoning-effort plumbing (only ever forwarded for known-reasoning models), and
the runtime title step (first Work Result only, bounded, sanitized, user rename
wins, never a failure of the turn).
"""
from __future__ import annotations

import sqlite3
import time

import pytest

from app import config
from app.agent_runtime import agent_service, model_budget, session_agent
from app.migrations import MIGRATIONS
from app.task_runtime import titling

from .fake_model import FakeModel, text_turn

MODEL_KEY = "sk-TESTKEY-DONOTLEAK-0110"


def _provider(client, model="gpt-4o-mini", **extra):
    body = {"name": "p", "provider_type": "openai", "base_url": "https://api.openai.com/v1",
            "model": model, "api_key": MODEL_KEY}
    body.update(extra)
    r = client.post("/model-providers", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def _wait_settled(client, task_id, exec_id, timeout=15.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        row = client.get(f"/agent-tasks/{task_id}/executions/{exec_id}").json()
        if row["status"] not in ("queued", "running"):
            return row
        time.sleep(0.05)
    raise AssertionError("execution never settled")


# --- migration 028 ---------------------------------------------------------------


def test_migration_028_adds_the_two_columns(client):
    assert MIGRATIONS[27][0] == 28
    conn = sqlite3.connect(str(config.db_path()))
    try:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(sessions)")}
        assert "title_source" in cols
        cols = {r[1] for r in conn.execute("PRAGMA table_info(model_providers)")}
        assert "reasoning_effort" in cols
    finally:
        conn.close()


# --- reasoning effort ------------------------------------------------------------


def test_reasoning_capability_is_a_bounded_model_name_table():
    assert model_budget.is_reasoning_model("o3-mini")
    assert model_budget.is_reasoning_model("gpt-5")
    assert model_budget.is_reasoning_model("deepseek-reasoner")
    assert model_budget.is_reasoning_model("qwen3-32b-thinking")
    assert not model_budget.is_reasoning_model("gpt-4o-mini")
    assert not model_budget.is_reasoning_model("llama3")
    assert not model_budget.is_reasoning_model(None)


def test_effort_round_trips_and_clears_on_the_provider_api(client):
    p = _provider(client, model="o3-mini", reasoning_effort="high")
    assert p["reasoning_effort"] == "high"
    assert p["reasoning_capable"] is True
    r = client.put(f"/model-providers/{p['id']}", json={"reasoning_effort": "low"})
    assert r.json()["reasoning_effort"] == "low"
    # Untouched on an unrelated update.
    r = client.put(f"/model-providers/{p['id']}", json={"name": "renamed"})
    assert r.json()["reasoning_effort"] == "low"
    # "" clears back to the model default.
    r = client.put(f"/model-providers/{p['id']}", json={"reasoning_effort": ""})
    assert r.json()["reasoning_effort"] is None
    r = client.put(f"/model-providers/{p['id']}", json={"reasoning_effort": "extreme"})
    assert r.status_code == 422


def test_effort_never_reaches_a_model_that_cannot_take_it(client):
    _provider(client, model="gpt-4o-mini", reasoning_effort="high")
    conn = sqlite3.connect(str(config.db_path()))
    conn.row_factory = sqlite3.Row
    try:
        creds = agent_service.get_model_credentials(conn)
    finally:
        conn.close()
    assert creds["reasoning_effort"] is None
    listed = client.get("/model-providers").json()[0]
    assert listed["reasoning_capable"] is False
    assert listed["reasoning_effort"] == "high"  # stored, just not forwarded


def test_effort_is_forwarded_for_a_reasoning_model(client):
    _provider(client, model="o3-mini", reasoning_effort="medium")
    conn = sqlite3.connect(str(config.db_path()))
    conn.row_factory = sqlite3.Row
    try:
        creds = agent_service.get_model_credentials(conn)
    finally:
        conn.close()
    assert creds["reasoning_effort"] == "medium"
    agent = session_agent._make_agent(creds, [], "x")
    assert agent.model_settings.reasoning is not None
    assert agent.model_settings.reasoning.effort == "medium"
    creds["reasoning_effort"] = None
    assert session_agent._make_agent(creds, [], "x").model_settings.reasoning is None


# --- title step: sanitizer + prompt ------------------------------------------------


@pytest.mark.parametrize("raw, expected", [
    ("Acme logs 403 on ListBucket", "Acme logs 403 on ListBucket"),
    ('"Slow reads on acme-backups."', "Slow reads on acme-backups"),
    ("Title: Lifecycle gaps in cold-tier prefixes\nmore text", "Lifecycle gaps in cold-tier prefixes"),
    ("**Bucket policy review**", "Bucket policy review"),
    ("one two three four five six seven eight nine ten", "one two three four five six seven eight"),
    ("", None),
    ("ok", None),
    ("see https://example.com/x", None),
])
def test_sanitize_title(raw, expected):
    assert titling.sanitize_title(raw) == expected


def test_the_title_prompt_is_marked_bounded_and_redacted():
    prompt = titling.build_prompt("d" * 5000,
                                  "AKIAIOSFODNN7EXAMPLE leaked " + "a" * 5000)
    assert titling.TITLE_MARKER in prompt
    assert "AKIAIOSFODNN7EXAMPLE" not in prompt
    assert len(prompt) < 2200


# --- title step: runtime -------------------------------------------------------------


def _task(client, title="check acme-logs"):
    return client.post("/sessions", json={"title": title, "goal": None}).json()


def _contract(answer="The policy omits s3:ListBucket."):
    return {"answer": answer, "skills_used": [], "skills_offered": [], "evidence_used": [],
            "evidence_gaps": [], "next_action_proposals": [], "tool_activity": []}


def _run(client, task_id, direction, turn_id):
    r = client.post(f"/agent-tasks/{task_id}/executions",
                    json={"direction": direction, "turn_id": turn_id})
    assert r.status_code == 201, r.text
    return _wait_settled(client, task_id, r.json()["execution"]["id"])


def test_streamed_runtime_titles_the_task_after_the_first_work_result(client):
    with FakeModel([text_turn("The policy omits s3:ListBucket."),
                    text_turn("Second answer.")], title="Acme logs 403 on list") as model:
        client.post("/model-providers", json={
            "name": "fake", "provider_type": "openai-compatible",
            "base_url": model.base_url, "model": "fake-model", "api_key": "not-a-real-key"})
        task = _task(client)
        row = _run(client, task["id"], "why does acme-logs return 403 on list?", "t1")
        assert row["status"] == "completed"
        listed = {t["id"]: t for t in client.get("/agent-tasks").json()}
        assert listed[task["id"]]["title"] == "Acme logs 403 on list"
        assert listed[task["id"]]["title_source"] == "agent"
        # One scripted turn consumed; the title request never touched the script.
        assert len(model.requests) == 1
        assert len(model.title_requests) == 1
        prompt_text = str(model.title_requests[0])
        assert "why does acme-logs return 403" in prompt_text
        events = client.get(f"/agent-tasks/{task['id']}/executions/{row['id']}/events",
                            params={"deltas": "false"}).text
        assert "event: task.titled" in events
        assert events.index("task.titled") < events.rindex("execution.status")

        # The second Work Result does not re-title.
        model.title = "Something else"
        _run(client, task["id"], "and the second bucket?", "t2")
        assert len(model.title_requests) == 1
        listed = {t["id"]: t for t in client.get("/agent-tasks").json()}
        assert listed[task["id"]]["title"] == "Acme logs 403 on list"


def test_an_empty_model_title_keeps_the_seed_title(client):
    with FakeModel([text_turn("Answer.")], title=None) as model:
        client.post("/model-providers", json={
            "name": "fake", "provider_type": "openai-compatible",
            "base_url": model.base_url, "model": "fake-model", "api_key": "not-a-real-key"})
        task = _task(client, title="seed title")
        _run(client, task["id"], "direction", "t1")
        listed = {t["id"]: t for t in client.get("/agent-tasks").json()}
        assert listed[task["id"]]["title"] == "seed title"
        assert listed[task["id"]]["title_source"] is None


def test_a_user_rename_wins_forever(client, monkeypatch):
    _provider(client)
    monkeypatch.setattr(session_agent, "SESSION_LOOP", lambda spec: _contract())
    task = _task(client)
    client.patch(f"/sessions/{task['id']}", json={"title": "my name"})
    listed = {t["id"]: t for t in client.get("/agent-tasks").json()}
    assert listed[task["id"]]["title_source"] == "user"
    conn = sqlite3.connect(str(config.db_path()))
    conn.row_factory = sqlite3.Row
    try:
        # Even a direct apply refuses to overwrite a user title.
        titling.apply_title(conn, task["id"], "agent name")
        conn.commit()
        assert conn.execute("SELECT title FROM sessions WHERE id = ?",
                            (task["id"],)).fetchone()[0] == "my name"
        assert conn.execute("SELECT title FROM agent_tasks WHERE id = ?",
                            (task["id"],)).fetchone()[0] == "my name"
    finally:
        conn.close()


def test_the_legacy_seam_never_titles(client, monkeypatch):
    """SESSION_LOOP fakes drive the legacy blocking path; the title step is part
    of the streamed runtime only, so fakes never trigger a network call."""
    _provider(client)
    calls = []
    monkeypatch.setattr(session_agent, "SESSION_LOOP", lambda spec: _contract())
    monkeypatch.setattr(titling, "TITLE_STEP", lambda *a: calls.append(a) or "X title")
    task = _task(client, title="seed")
    _run(client, task["id"], "direction", "t1")
    assert calls == []
    listed = {t["id"]: t for t in client.get("/agent-tasks").json()}
    assert listed[task["id"]]["title"] == "seed"


def test_run_title_step_uses_the_seam_and_syncs_the_durable_task_row(client):
    _provider(client)
    task = _task(client, title="seed")
    conn = sqlite3.connect(str(config.db_path()))
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("INSERT INTO session_messages (id, session_id, role, content, created_at) "
                     "VALUES ('m1', ?, 'assistant', 'answer', '2026-01-01T00:00:00Z')",
                     (task["id"],))
        conn.commit()
        original = titling.TITLE_STEP
        titling.TITLE_STEP = lambda creds, d, a: '"Cold-tier lifecycle gaps."'
        try:
            assert titling.run_title_step(conn, task["id"], "d", "a", {"model": "x"}) == \
                "Cold-tier lifecycle gaps"
        finally:
            titling.TITLE_STEP = original
        conn.commit()
        assert conn.execute("SELECT title, title_source FROM sessions WHERE id = ?",
                            (task["id"],)).fetchone()[:] == ("Cold-tier lifecycle gaps", "agent")
        assert conn.execute("SELECT title FROM agent_tasks WHERE id = ?",
                            (task["id"],)).fetchone()[0] == "Cold-tier lifecycle gaps"
        # A raising seam is swallowed: the turn is never failed by a title.
        titling.TITLE_STEP = lambda *a: (_ for _ in ()).throw(RuntimeError("boom"))
        try:
            assert titling.run_title_step(conn, task["id"], "d", "a", {"model": "x"}) is None
        finally:
            titling.TITLE_STEP = original
    finally:
        conn.close()
