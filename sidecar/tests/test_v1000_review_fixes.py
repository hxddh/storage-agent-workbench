"""Regression contracts for the v10 review fixes.

These are boundary tests, not UI tests: a Direction must never carry a vault
secret into items or a model request; a withdrawn Direction must never become a
version; an accepted-risk reason must leave with its bucket; and parallel tool
outputs must publish in seq order so the SSE follower cannot skip a durable item.
"""

from __future__ import annotations

import threading
import time

import pytest

from app.agent.runtime import RUNTIME
from app.agent.recorder import Recorder
from app.core import hub, store
from app.estate import notes
from app.estate import store as estate
from app.security import keyring_store
from tests.fake_model import FakeModel, text_turn


@pytest.fixture()
def provider(conn):
    conn.execute("INSERT INTO cloud_providers (id, name, provider_type, created_at, updated_at) "
                 "VALUES ('p1', 'prod', 's3', 'x', 'x')")
    conn.commit()
    return conn


def _use(client, fake: FakeModel) -> str:
    return client.post("/providers/models", json={
        "name": "fake", "kind": "openai-compatible", "base_url": fake.base_url, "model": "fake-model",
    }).json()["id"]


def _settle(client, task_id: str, timeout: float = 20.0) -> dict:
    deadline = time.monotonic() + timeout
    snap: dict = {}
    while time.monotonic() < deadline:
        snap = client.get(f"/tasks/{task_id}").json()
        if snap["state"] not in ("working", "queued"):
            return snap
        time.sleep(0.03)
    raise AssertionError(f"task still {snap.get('state')}")


def test_a_vault_secret_in_a_direction_never_reaches_items_the_model_or_the_report(client):
    secret = "custom-secret-value-42"
    client.post("/providers/clouds", json={
        "name": "prod", "provider_type": "s3-compatible", "endpoint_url": "https://minio.example.com",
        "region": "us-east-1", "addressing_style": "path", "access_key": "ACCESS", "secret_key": secret,
    })
    with FakeModel([text_turn("ok")]) as fake:
        _use(client, fake)
        tid = client.post("/tasks", json={"direction": f"my key is {secret}"}).json()["task"]["id"]
        snap = _settle(client, tid)
        request = str(fake.requests[0])
        items = str(snap["items"])
        report = client.get(f"/tasks/{tid}/report").text
    assert secret not in request
    assert secret not in items
    assert secret not in report


def test_a_withdrawn_direction_is_not_a_version(provider):
    conn = provider
    task = store.create_task(conn, "t")
    first = store.create_turn(conn, task["id"], "one", status="completed")
    second = store.create_turn(conn, task["id"], "withdrawn")
    assert RUNTIME.cancel_queued(conn, task["id"], second["id"])
    assert second["id"] not in store.siblings(conn, task["id"]).get(first["id"], [])


def test_an_accepted_risk_reason_leaves_when_its_bucket_disappears(provider):
    conn = provider
    estate.upsert_bucket(conn, "p1", "b")
    iid = estate.observe(conn, "p1", "b", {"no_default_encryption": True}, source="survey")[0]["issue_id"]
    estate.set_accepted(conn, iid, True, reason="Test bucket, no data")
    assert any("Test bucket" in n["text"] for n in notes.list_notes(conn))
    estate.ingest_survey(conn, "p1", {"whole_account": True, "buckets": []})
    assert estate.get_issue(conn, iid)["status"] == "resolved"
    assert not any("Test bucket" in n["text"] for n in notes.list_notes(conn))


def test_audit_and_tool_targets_never_keep_an_exact_vault_secret(provider):
    conn = provider
    secret = "audit-only-secret-42"
    keyring_store.save_secret("test", "audit", secret)
    store.audit(conn, actor="user", action="test.action", target=f"file-{secret}.log",
                detail={"echo": secret})
    row = conn.execute("SELECT target, detail FROM audit ORDER BY rowid DESC LIMIT 1").fetchone()
    assert secret not in (row["target"] or "") and secret not in (row["detail"] or "")

    task = store.create_task(conn, "t")
    turn = store.create_turn(conn, task["id"], "one", status="running")
    rec = Recorder(task["id"], turn["id"])
    rec.tool_started("c1", "triage_error", {"message": secret}, secret)
    rec.close()
    payload = conn.execute("SELECT payload FROM items WHERE type = 'tool_call' ORDER BY seq DESC LIMIT 1").fetchone()["payload"]
    assert secret not in payload

    from app.agent.safety import StreamSanitizer
    live = StreamSanitizer().push(f"before {secret} after", final=True)
    assert secret not in live


def test_parallel_tool_outputs_publish_in_seq_order(provider, monkeypatch):
    conn = provider
    task = store.create_task(conn, "t")
    turn = store.create_turn(conn, task["id"], "one", status="running")
    from app.agent.recorder import Recorder

    rec = Recorder(task["id"], turn["id"])
    started, release = threading.Event(), threading.Event()
    published: list[str] = []

    def record(_task_id, item):
        call = item["payload"]["call_id"]
        if call == "a":
            started.set()
            assert release.wait(2)
        published.append(call)

    monkeypatch.setattr(hub, "item", record)
    first = threading.Thread(target=lambda: rec.tool_finished("a", "query_estate", True, "ok", {"n": 1}, 1))
    second = threading.Thread(target=lambda: rec.tool_finished("b", "query_estate", True, "ok", {"n": 2}, 1))
    first.start()
    assert started.wait(2)
    second.start()
    time.sleep(0.05)
    release.set()
    first.join(2)
    second.join(2)
    rec.close()
    assert published == ["a", "b"]
