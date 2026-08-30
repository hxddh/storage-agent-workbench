"""v0.51.0 — what the agent knows, and whether a turn is running.

Two gaps this pins shut.

**The agent's memory was invisible.** It writes facts, findings and open
questions as it investigates (``note_fact`` / ``record_finding`` /
``note_open_question``) and replays them into the context of EVERY later turn —
so a wrong fact steers the rest of the session. Before v0.51.0 the session
endpoint did not return any of it, and the report rendered only *findings*: two
of the three kinds existed nowhere a person could see. There was also no way to
correct one, only for the agent to correct itself.

**A turn had no server-visible state.** Client run state lives in memory, so
reloading the app mid-turn showed an idle session while the worker kept
generating and spending.
"""

from __future__ import annotations

import pytest

from app import db
from app.repositories import sessions as repo


@pytest.fixture()
def conn(client):
    """A connection to the same temp database the TestClient uses."""
    c = db.connect()
    try:
        yield c
    finally:
        c.close()


def _session(client, title="v051"):
    return client.post("/sessions", json={"title": title}).json()["id"]


def _seed(conn, sid):
    return {
        "fact": repo.add_agent_memory(
            conn, sid, "fact", "bucket acme-logs is path-style only", confidence="high"),
        "finding": repo.add_agent_memory(
            conn, sid, "finding", "acme-logs has no lifecycle rule", severity="high"),
        "question": repo.add_agent_memory(
            conn, sid, "open_question", "is cross-region replication intentional?"),
    }


def test_session_detail_exposes_what_the_agent_knows(client, conn):
    sid = _session(client)
    _seed(conn, sid)
    conn.commit()

    body = client.get(f"/sessions/{sid}").json()
    kinds = sorted(m["kind"] for m in body["agent_memory"])
    # All three kinds, not just the one the report happened to render.
    assert kinds == ["fact", "finding", "open_question"]
    assert body["attached_files"] == []
    # How much of the thread the agent actually replays — below `message_total`
    # means the earliest turns have rolled out of its view.
    assert body["context_messages"] > 0


def test_a_user_can_correct_a_wrong_fact(client, conn):
    sid = _session(client)
    ids = _seed(conn, sid)
    conn.commit()

    r = client.patch(f"/sessions/{sid}/memory/{ids['fact']}",
                     json={"text": "acme-logs supports virtual-host addressing"})
    assert r.status_code == 200
    facts = [m["text"] for m in r.json()["agent_memory"] if m["kind"] == "fact"]
    assert facts == ["acme-logs supports virtual-host addressing"]
    # The correction is an auditable event, attributed to the user — a later
    # reader must be able to tell which premises the agent derived and which a
    # human overrode (rule 17).
    events = client.get(f"/sessions/{sid}/audit").json()["items"]
    edit = [e for e in events if e["event_type"] == "session.memory_edit"]
    assert len(edit) == 1 and edit[0]["payload"]["by"] == "user"


def test_correcting_a_fact_redacts_it_like_the_agents_own_writes(client, conn):
    sid = _session(client)
    ids = _seed(conn, sid)
    conn.commit()
    leak = "the key is AKIAIOSFODNN7EXAMPLE and it works"
    r = client.patch(f"/sessions/{sid}/memory/{ids['fact']}", json={"text": leak})
    assert r.status_code == 200
    stored = [m["text"] for m in r.json()["agent_memory"] if m["kind"] == "fact"][0]
    # This text is replayed into the model's context on the next turn, so it
    # goes through the same redaction as everything else the agent records.
    assert "AKIAIOSFODNN7EXAMPLE" not in stored
    for row in client.get(f"/sessions/{sid}/audit").json()["items"]:
        assert "AKIAIOSFODNN7EXAMPLE" not in str(row)


def test_resolving_an_item_takes_it_out_of_the_agents_context(client, conn):
    sid = _session(client)
    ids = _seed(conn, sid)
    conn.commit()

    r = client.post(f"/sessions/{sid}/memory/{ids['question']}/resolve",
                    json={"reason": "confirmed intentional"})
    assert r.status_code == 200
    assert sorted(m["kind"] for m in r.json()["agent_memory"]) == ["fact", "finding"]
    # Resolved, not deleted: the row survives for the audit trail, it just
    # stops being replayed.
    row = conn.execute(
        "SELECT status FROM session_agent_memory WHERE id = ?", (ids["question"],)
    ).fetchone()
    assert row[0] == "resolved"


def test_memory_endpoints_reject_unknown_ids(client, conn):
    sid = _session(client)
    assert client.patch(f"/sessions/{sid}/memory/nope", json={"text": "x"}).status_code == 404
    assert client.post(f"/sessions/{sid}/memory/nope/resolve", json={}).status_code == 404
    assert client.patch("/sessions/missing/memory/nope", json={"text": "x"}).status_code == 404


def test_the_report_covers_all_three_kinds_of_memory(client, conn):
    sid = _session(client)
    _seed(conn, sid)
    conn.commit()
    content = client.get(f"/sessions/{sid}/report").json()["content"]
    # Before v0.51.0 only the finding appeared: the report stated conclusions
    # while omitting the premises they rested on and the questions left open.
    assert "path-style only" in content
    assert "no lifecycle rule" in content
    assert "replication intentional" in content
    assert "## What the agent established" in content
    assert "## What the agent left open" in content


def test_report_bounds_a_runaway_memory_and_says_so(client, conn):
    sid = _session(client)
    for i in range(60):
        repo.add_agent_memory(conn, sid, "fact", f"fact number {i}")
    conn.commit()
    content = client.get(f"/sessions/{sid}/report").json()["content"]
    assert "fact number 0" in content
    assert "fact number 59" not in content
    # Truncation is never silent.
    assert "10 more facts recorded" in content


def test_turn_state_is_not_running_by_default(client, conn):
    sid = _session(client)
    body = client.get(f"/sessions/{sid}/turn").json()
    assert body["running"] is False and body["turn_id"] is None
    assert client.get("/sessions/missing/turn").status_code == 404


def _register_execution(conn, session_id: str, turn_id: str) -> str:
    """A durable in-flight execution row, as runtime.submit would create."""
    from app.task_runtime import store as task_store
    task_store.ensure_task(conn, session_id)
    execution = task_store.create_execution(conn, session_id, "in-flight", turn_id)
    conn.commit()
    return execution["id"]


def test_turn_state_reports_a_live_turn_and_stops_when_it_ends(client, conn):
    from app.task_runtime import store as task_store
    sid = _session(client)
    exec_id = _register_execution(conn, sid, "turn-abc")
    body = client.get(f"/sessions/{sid}/turn").json()
    # This is the whole point: a client that reloaded mid-turn has no local
    # state, and must be able to learn the turn is still running. Since v0.94
    # the answer comes from the DURABLE execution row, so it also survives a
    # sidecar restart (where recovery marks the execution interrupted).
    assert body["running"] is True
    assert body["turn_id"] == "turn-abc"
    assert body["started_at"] and body["age_ms"] is not None
    assert body["execution_id"] == exec_id

    task_store.set_execution_status(conn, exec_id, task_store.EXEC_COMPLETED)
    conn.commit()
    assert client.get(f"/sessions/{sid}/turn").json()["running"] is False


def test_a_turn_is_never_reported_for_another_session(client, conn):
    a, b = _session(client, "a"), _session(client, "b")
    _register_execution(conn, a, "turn-xyz")
    assert client.get(f"/sessions/{a}/turn").json()["running"] is True
    assert client.get(f"/sessions/{b}/turn").json()["running"] is False


def test_attached_files_are_listed_without_their_filesystem_paths(client, conn):
    from app.repositories import session_datasets as sds

    sid = _session(client)
    sds.create(conn, sid, "inventory", "acme-inventory.csv", "sessions/x/acme-inventory.csv")
    conn.commit()

    files = client.get(f"/sessions/{sid}").json()["attached_files"]
    assert len(files) == 1
    assert files[0]["source_filename"] == "acme-inventory.csv"
    # The app data dir carries the OS username, and this shape is rendered in
    # the UI and copied into exports.
    assert "stored_path" not in files[0]
    assert "duckdb_path" not in files[0]
