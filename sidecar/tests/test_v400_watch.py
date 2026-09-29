"""v4.0.0 — proactive watch: a bounded, read-only sweep on the Sidecar's clock.

Opt-in per cloud provider, off by default. A due sweep runs the survey engine
(read-only, ≤ 500 buckets), re-checks what posture cannot decide, and — only
when something new was found — opens ONE Agent Task through the one runtime
path with the evidence in its Direction. Turning the watch off stops a
scheduled sweep between phases. Driven here against a real S3 server and a
fake OpenAI-compatible model.
"""

from __future__ import annotations

import time

import boto3
import pytest
from botocore.config import Config

from app import db, run_service
from app.estate import watch
from tests.live_s3 import live_s3_endpoint  # noqa: F401

from .fake_model import FakeModel, text_turn

ACCESS = "AKIAIOSFODNN7EXAMPLE"
SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
WATCHED = "watch-golden"


@pytest.fixture()
def provider(client, live_s3_endpoint):  # noqa: F811
    s3 = boto3.client("s3", endpoint_url=live_s3_endpoint, region_name="us-east-1",
                      aws_access_key_id=ACCESS, aws_secret_access_key=SECRET,
                      config=Config(s3={"addressing_style": "path"}))
    try:
        s3.create_bucket(Bucket=WATCHED)
    except s3.exceptions.BucketAlreadyOwnedByYou:
        pass
    return client.post("/cloud-providers", json={
        "name": "prod-watch", "provider_type": "s3-compatible",
        "endpoint_url": live_s3_endpoint, "region": "us-east-1",
        "addressing_style": "path", "access_key": ACCESS, "secret_key": SECRET,
        "mode": "readonly",
    }).json()["id"]


def _model(client, model):
    client.post("/model-providers", json={
        "name": "fake", "provider_type": "openai-compatible", "base_url": model.base_url,
        "model": "fake-model", "api_key": "not-a-real-key"})


def _settled(client, task_id, timeout=60.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = client.get(f"/agent-tasks/{task_id}/executions").json()
        rows = state if isinstance(state, list) else state.get("executions", [])
        if rows and all(r["status"] not in ("queued", "running") for r in rows):
            return rows
        time.sleep(0.05)
    raise AssertionError("watch task never settled")


def test_watch_is_off_by_default_and_never_due(client, provider):
    assert client.get(f"/estate/watch/{provider}").json()["enabled"] is False
    conn = db.connect()
    try:
        assert watch.due(conn) == []
    finally:
        conn.close()
    assert watch.tick() == 0


def test_a_due_sweep_opens_one_task_through_the_runtime(client, provider):
    with FakeModel([text_turn("The watch found a missing public access block.")]) as model:
        _model(client, model)
        r = client.put(f"/estate/watch/{provider}", json={"enabled": True, "interval_hours": 24})
        assert r.status_code == 200 and r.json()["enabled"] is True and r.json()["next_run_at"]
        assert watch.tick() == 1
        state = client.get(f"/estate/watch/{provider}").json()
        assert state["last_status"] == "found", state
        task_id = state["last_task_id"]
        assert task_id
        rows = _settled(client, task_id)
    assert rows[0]["status"] == "completed"
    direction = client.get(f"/sessions/{task_id}/messages").json()["messages"][0]["content"]
    assert direction.startswith("[watch]") and WATCHED in direction
    assert "never change it" in direction
    # The issues it found now open this task from the home.
    issues = client.get("/issues", params={"provider_id": provider}).json()
    assert any(i["bucket"] == WATCHED and i["source_task_id"] == task_id for i in issues)
    # Not due again until its interval has passed.
    assert watch.tick() == 0
    # The home says when the estate was last watched.
    assert client.get("/estate").json()["last_watch_at"]


def test_nothing_new_costs_no_model_call_and_opens_no_task(client, provider):
    with FakeModel([text_turn("first")]) as model:
        _model(client, model)
        assert watch.sweep(provider)["status"] == "found"
        _settled(client, client.get(f"/estate/watch/{provider}").json()["last_task_id"])
        calls = len(model.requests)
        again = watch.sweep(provider)
    assert again["status"] == "clear" and again["task_id"] is None
    assert len(model.requests) == calls


def test_turning_the_watch_off_stops_a_scheduled_sweep_between_phases(client, provider, monkeypatch):
    real = run_service.run_sync

    def survey_then_switch_off(run_id):
        real(run_id)
        client.put(f"/estate/watch/{provider}", json={"enabled": False, "interval_hours": 24})

    monkeypatch.setattr(run_service, "run_sync", survey_then_switch_off)
    with FakeModel([text_turn("should not run")]) as model:
        _model(client, model)
        client.put(f"/estate/watch/{provider}", json={"enabled": True, "interval_hours": 24})
        out = watch.sweep(provider, scheduled=True)
    assert out["task_id"] is None
    assert model.requests == []
    assert client.get(f"/estate/watch/{provider}").json()["next_run_at"] is None


def test_without_a_model_the_issues_stay_on_the_home(client, provider):
    out = watch.sweep(provider)
    assert out["status"] == "found" and out["task_id"] is None
    assert "No model is configured" in out["summary"]
    assert client.get("/estate").json()["open_issue_count"] >= 1


def test_the_interval_is_bounded_and_check_now_is_one_at_a_time(client, provider):
    r = client.put(f"/estate/watch/{provider}", json={"enabled": True, "interval_hours": 100000})
    assert r.json()["interval_hours"] == watch.MAX_HOURS
    r = client.put(f"/estate/watch/{provider}", json={"enabled": True, "interval_hours": 0})
    assert r.json()["interval_hours"] == watch.MIN_HOURS
    assert client.post("/estate/watch/nope/run").status_code == 404
    with watch._lock:
        watch._running.add(provider)
    try:
        assert client.post(f"/estate/watch/{provider}/run").json()["started"] is False
    finally:
        with watch._lock:
            watch._running.discard(provider)


def test_watch_sweeps_keep_only_the_last_few_runs(client, provider):
    for _ in range(watch.KEEP_RUNS + 2):
        watch.sweep(provider)
    conn = db.connect()
    try:
        n = conn.execute("SELECT COUNT(*) FROM runs WHERE origin = 'watch' AND provider_id = ?",
                         (provider,)).fetchone()[0]
    finally:
        conn.close()
    assert n == watch.KEEP_RUNS
