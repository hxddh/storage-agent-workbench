"""Regression contracts for the v11 release fixes.

Deleting a Task while its Turn was finalizing made the Turn's last item fail
its foreign key. The exception escaped the runtime's cleanup, leaving the
recorder connection open; its write transaction then locked every later write
for the life of the Sidecar. These tests pin both halves of the fix: a vanished
task stops recording cleanly, and DELETE stops the worker before the rows go.

v11.1 also pins one consistent read for a task snapshot: a turn that settles
between two SELECTs must not produce "ready" around a turn still shown running.
"""

from __future__ import annotations

import time

from app import db
from app.agent.recorder import Recorder
from app.agent.runtime import RUNTIME
from app.api import tasks as tasks_api
from app.core import store
from tests.fake_model import FakeModel, text_turn


def _use(client, fake: FakeModel) -> str:
    return client.post("/providers/models", json={
        "name": "fake", "kind": "openai-compatible", "base_url": fake.base_url, "model": "fake-model",
    }).json()["id"]


def test_a_snapshot_reads_the_task_and_its_turns_from_one_transaction(conn, monkeypatch):
    task = store.create_task(conn, "t")
    turn = store.create_turn(conn, task["id"], "one", status="running")

    real_branch = store.branch

    def branch_then_finish(c, task_id, head_turn_id=None):
        out = real_branch(c, task_id, head_turn_id)
        # The turn settles after `branch` read it but before the snapshot asks
        # for the active turns. A snapshot must still tell one coherent story.
        other = db.connect()
        try:
            store.set_turn_status(other, turn["id"], "completed")
        finally:
            other.close()
        return out

    monkeypatch.setattr(tasks_api.store, "branch", branch_then_finish)
    snap = tasks_api.snapshot(conn, task["id"])
    assert snap["turns"][0]["status"] == "running"
    assert snap["state"] == "working"


def test_a_turn_whose_task_vanished_stops_recording_without_locking_sqlite(conn, monkeypatch):
    task = store.create_task(conn, "t")
    turn = store.create_turn(conn, task["id"], "one", status="running")
    rec = Recorder(task["id"], turn["id"])
    try:
        # Exactly what DELETE /tasks does once the worker is stopped.
        store.delete_task(conn, task["id"])

        # A late notice must be a no-op. Before the fix it raised IntegrityError
        # and left the recorder's write transaction open.
        rec.notice("completed")
        assert rec._conn.in_transaction is False

        # Shorten the wait so a leaked transaction fails the test quickly rather
        # than after the production 30 s busy timeout.
        monkeypatch.setattr(db, "_CONNECT_BUSY_TIMEOUT_MS", 500)
        other = db.connect()
        try:
            store.create_task(other, "after")
        finally:
            other.close()
    finally:
        rec.close()


def test_deleting_a_running_task_stops_it_and_leaves_the_database_writable(client, monkeypatch):
    monkeypatch.setattr(db, "_CONNECT_BUSY_TIMEOUT_MS", 500)
    with FakeModel([text_turn("word " * 600, chunk_size=4)], delay_s=0.01) as fake:
        _use(client, fake)
        tid = client.post("/tasks", json={"direction": "Write a lot"}).json()["task"]["id"]

        deadline = time.monotonic() + 10
        while not RUNTIME.is_running(tid) and time.monotonic() < deadline:
            time.sleep(0.02)
        assert RUNTIME.is_running(tid)

        started = time.monotonic()
        assert client.delete(f"/tasks/{tid}").status_code == 204
        assert not RUNTIME.is_running(tid)
        assert client.get(f"/tasks/{tid}").status_code == 404

        # The next write must not wait on a transaction the deleted Turn left
        # behind. A 500 here is the release bug; a long wait is the same bug.
        created = client.post("/providers/models", json={
            "name": "second", "kind": "openai-compatible", "base_url": fake.base_url, "model": "fake-model",
        })
        assert created.status_code == 201, created.text
        assert time.monotonic() - started < 5
