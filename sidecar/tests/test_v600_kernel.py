"""v6 kernel: a call's stop signal is set by the turn's Stop or by the call's own timeout."""

from __future__ import annotations

import threading

from app.agent.tools.registry import CallContext, StopSignal, TurnContext


def _turn() -> TurnContext:
    return TurnContext(task_id="t", turn_id="u", cancel=threading.Event(), recorder=None)


def test_a_turn_stop_reaches_every_call():
    turn = _turn()
    a, b = CallContext(turn, "c1", "x"), CallContext(turn, "c2", "y")
    assert not a.cancelled and not b.cancelled
    turn.cancel.set()
    assert a.cancelled and b.cancelled


def test_one_call_timing_out_stops_only_that_call():
    turn = _turn()
    a, b = CallContext(turn, "c1", "x"), CallContext(turn, "c2", "y")
    assert isinstance(a.stop, StopSignal)
    a.stop.set()
    assert a.cancelled
    assert not b.cancelled
    assert not turn.cancel.is_set()


def test_a_failure_on_a_branch_left_behind_does_not_need_attention(conn):
    from app.core import store

    task = store.create_task(conn, "t")
    first = store.create_turn(conn, task["id"], "look")
    store.set_turn_status(conn, first["id"], "failed")
    assert store.list_tasks(conn)[0]["state"] == "needs_attention"
    # A later turn answers and becomes the head the task is read at.
    second = store.create_turn(conn, task["id"], "look again")
    store.set_turn_status(conn, second["id"], "completed")
    store.set_head(conn, task["id"], second["id"])
    assert store.head_status(conn, task["id"]) == "completed"
    assert store.list_tasks(conn)[0]["state"] == "ready"
    # Switching back to the failed version reads as needing attention again.
    store.set_head(conn, task["id"], first["id"])
    assert store.list_tasks(conn)[0]["state"] == "needs_attention"


# --- estate view + notes ------------------------------------------------------------

def _provider(client, name="acct"):
    return client.post("/providers/clouds", json={
        "name": name, "provider_type": "s3-compatible", "endpoint_url": "http://127.0.0.1:9",
        "region": "us-east-1", "access_key": "AKIAIOSFODNN7EXAMPLE",
        "secret_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "mode": "readonly"}).json()["id"]


def test_a_bucket_page_tells_its_story(client):
    from app.db import connect
    from app.estate import store as estate

    pid = _provider(client)
    conn = connect()
    try:
        exposed = {"bucket_name": "b1", "region": "us-east-1", "publicly_exposed": True,
                   "encryption_status": "available"}
        estate.ingest_survey(conn, pid, {"buckets": [exposed]})
        estate.ingest_survey(conn, pid, {"buckets": [exposed]})  # unchanged: no new history row
        estate.ingest_survey(conn, pid, {"buckets": [exposed | {"publicly_exposed": False}]})
    finally:
        conn.close()

    listing = client.get(f"/estate/providers/{pid}/buckets").json()
    assert [b["bucket"] for b in listing["buckets"]] == ["b1"]
    page = client.get(f"/estate/providers/{pid}/buckets/b1").json()
    posture = [t for t in page["timeline"] if t["kind"] == "posture"]
    assert len(posture) == 2 and posture[-1]["first"] is True
    assert posture[0]["changed"] == ["publicly_exposed"]
    events = {t["event"] for t in page["timeline"] if t["kind"] == "issue"}
    assert {"opened", "resolved"} <= events
    assert client.get(f"/estate/providers/{pid}/buckets/nope").status_code == 404


def test_notes_are_visible_editable_bounded_and_reach_the_digest(client):
    from app.agent.prompt import dynamic_context
    from app.db import connect

    pid = _provider(client)
    n = client.post("/notes", json={"text": "Owned by the data team; public on purpose for the CDN.",
                                    "provider_id": pid, "bucket": "cdn-assets"}).json()
    assert n["source"] == "user"
    # Secrets never stay in a note.
    s = client.post("/notes", json={"text": "key wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "provider_id": pid}).json()
    assert "EXAMPLEKEY" not in s["text"]
    assert client.post("/notes", json={"text": "x", "bucket": "orphan"}).status_code == 422
    edited = client.patch(f"/notes/{n['id']}", json={"text": "Owned by the data team."}).json()
    assert edited["text"] == "Owned by the data team."

    conn = connect()
    try:
        ctx = dynamic_context(conn)
        assert "Owned by the data team." in ctx and "estate_digest" in ctx
        actions = {r["action"] for r in conn.execute("SELECT action FROM audit").fetchall()}
        assert {"note.add", "note.edit"} <= actions
    finally:
        conn.close()
    assert client.delete(f"/notes/{n['id']}").status_code == 204
    assert all(x["id"] != n["id"] for x in client.get("/notes").json())


def test_accepting_a_risk_with_a_reason_keeps_it_as_a_note(client):
    from app.db import connect
    from app.estate import store as estate

    pid = _provider(client)
    conn = connect()
    try:
        estate.ingest_survey(conn, pid, {"buckets": [{"bucket_name": "b2", "publicly_exposed": True}]})
    finally:
        conn.close()
    issue = client.get("/issues", params={"provider_id": pid}).json()[0]
    out = client.post(f"/issues/{issue['id']}/accept", json={"reason": "Static website bucket."}).json()
    assert out["status"] == "accepted"
    page = client.get(f"/estate/providers/{pid}/buckets/b2").json()
    assert page["notes"][0]["source"] == "accept" and page["notes"][0]["issue_id"] == issue["id"]
