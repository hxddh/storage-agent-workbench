"""v11 — the contracts the Agent-native window reads.

These are additive: an optional context on the Direction, turn-level evidence
attached to a conclusion by the recorder, and scoped estate notes returned by
``query_estate``. No schema change, no new tool, no new source of truth.
"""

from __future__ import annotations

import json
import time

from app.agent import tools as _tools  # noqa: F401
from app.agent.recorder import Recorder
from app.agent.session import to_input
from app.agent.tools import registry
from app.core import store
from app.estate import notes
from app.estate import store as estate
from tests.fake_model import FakeModel, text_turn


def _provider(client, name: str = "prod", allowed: list[str] | None = None) -> str:
    return client.post("/providers/clouds", json={
        "name": name, "provider_type": "s3-compatible", "endpoint_url": "https://minio.example.com",
        "region": "us-east-1", "addressing_style": "path", "access_key": "ACCESS",
        "secret_key": "secret-value-for-tests", "allowed_buckets": allowed or [],
    }).json()["id"]


def _use(client, fake: FakeModel) -> str:
    return client.post("/providers/models", json={
        "name": "fake", "kind": "openai-compatible", "base_url": fake.base_url, "model": "fake-model",
    }).json()["id"]


def _settle(client, task_id: str, timeout: float = 15.0) -> dict:
    deadline = time.monotonic() + timeout
    snap: dict = {}
    while time.monotonic() < deadline:
        snap = client.get(f"/tasks/{task_id}").json()
        if snap["state"] not in ("working", "queued"):
            return snap
        time.sleep(0.03)
    raise AssertionError(f"task still {snap.get('state')}")


def test_direction_context_is_resolved_replayed_and_bounded(client, conn):
    pid = _provider(client)
    estate.upsert_bucket(conn, pid, "b")
    conn.commit()
    with FakeModel([text_turn("ok")]) as fake:
        _use(client, fake)
        task_id = client.post("/tasks", json={
            "direction": "Review this bucket",
            "context": [{"kind": "bucket", "provider_id": pid, "bucket": "b"}],
        }).json()["task"]["id"]
        snap = _settle(client, task_id)
        request = str(fake.requests[0])

    user = next(i for i in snap["items"] if i["type"] == "user_message")
    assert user["payload"]["context"] == [
        {"kind": "bucket", "provider_id": pid, "account": "prod", "bucket": "b"},
    ]
    assert "[Context: bucket · prod · bucket b]" in request
    assert "secret-value-for-tests" not in json.dumps(user)
    assert "model_output" not in user["payload"]

    # Context is focus, not authorization. A bucket the estate does not know is
    # refused before a task is created; the provider scope still decides access.
    before = len(client.get("/tasks").json()["tasks"])
    refused = client.post("/tasks", json={
        "direction": "Review it", "context": [{"kind": "bucket", "provider_id": pid, "bucket": "unknown"}],
    })
    assert refused.status_code == 422
    assert len(client.get("/tasks").json()["tasks"]) == before


def test_a_conclusion_carries_the_turns_successful_checks_only(conn):
    task = store.create_task(conn, "t")
    turn = store.create_turn(conn, task["id"], "look", status="running")
    rec = Recorder(task["id"], turn["id"])
    try:
        rec.tool_started("a", "query_estate", {}, "prod")
        rec.tool_finished("a", "query_estate", True, "2 buckets", {"success": True}, 12)
        rec.tool_started("b", "read_skill", {}, "")
        rec.tool_finished("b", "read_skill", True, "loaded", "text", 1)
        rec.tool_started("c", "list_buckets", {}, "prod")
        rec.tool_finished("c", "list_buckets", False, "access denied", {"error": "denied"}, 4)
        rec.conclusion("k", {"findings": [{"title": "A", "severity": "high"}]})
    finally:
        rec.close()
    rows = conn.execute("SELECT type, payload FROM items WHERE task_id = ? ORDER BY seq", (task["id"],)).fetchall()
    conclusion = next(json.loads(r["payload"]) for r in rows if r["type"] == "conclusion")
    assert conclusion["evidence"] == [
        {"call_id": "a", "name": "query_estate", "target": "prod", "summary": "2 buckets"},
    ]
    # Evidence is a surface fact; it never becomes a fake tool argument in the replay.
    replay = json.dumps(to_input([
        {"type": r["type"], "turn_id": turn["id"], "id": f"i{n}", "payload": json.loads(r["payload"])}
        for n, r in enumerate(rows)
    ]))
    assert "evidence" not in replay


def test_query_estate_returns_scoped_notes_and_recent_issue_events(client, conn):
    pid = _provider(client)
    estate.upsert_bucket(conn, pid, "b")
    estate.upsert_bucket(conn, pid, "other")
    notes.add(conn, "owner: payments", provider_id=pid, bucket="b", source="agent")
    notes.add(conn, "owner: media", provider_id=pid, bucket="other", source="agent")
    estate.observe(conn, pid, "b", {"no_default_encryption": True}, source="survey")
    conn.commit()

    out = registry.call_direct("query_estate", {"provider_id": pid, "bucket": "b"},
                               actor="mcp", allowed=frozenset(registry.REGISTRY))
    assert out["success"] is True
    assert [n["text"] for n in out["notes"]] == ["owner: payments"]
    assert out["issue_events"] and out["issue_events"][0]["kind"] == "opened"
    # An account query includes bucket notes but stays bounded.
    for i in range(30):
        notes.add(conn, f"note {i}", provider_id=pid, bucket="b", source="agent")
    again = registry.call_direct("query_estate", {"provider_id": pid},
                                 actor="mcp", allowed=frozenset(registry.REGISTRY))
    assert len(again["notes"]) == 20
