"""v8.1: the review's remaining suspicions, confirmed and fixed."""

from __future__ import annotations

import threading

import pytest

from app.agent.recorder import Recorder
from app.agent.runtime import RUNTIME
from app.agent.tools import registry
from app.core import store
from app.estate import notes

from .fake_model import FakeModel, text_turn
from .test_v500_runtime import _settle, _use


def test_parallel_calls_never_overspend_a_turn_budget():
    turn = registry.TurnContext("t", "u", threading.Event(), recorder=None)
    granted = []
    start = threading.Barrier(40)

    def spend():
        ctx = registry.CallContext(turn, "c", "note")
        start.wait()
        granted.append(ctx.budget("notes", 5))

    threads = [threading.Thread(target=spend) for _ in range(40)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert granted.count(True) == 5


def test_a_tool_that_outlives_its_turn_writes_nothing(client, conn):
    task = store.create_task(conn, "t")
    turn = store.create_turn(conn, task["id"], "x")
    rec = Recorder(task["id"], turn["id"])
    rec.tool_started("c1", "survey_account", {}, "prod")
    rec.tool_finished("c1", "survey_account", False, "stopped", None, 0)
    rec.progress("c1", "survey_account", 10, 500, "buckets")  # after the call settled
    rec.close()
    assert rec.notice("late") == {}  # after the turn's record closed: dropped, not raised
    types = [i["type"] for i in store.items_for_turns(conn, [turn["id"]])]
    assert "tool_progress" not in types and types.count("notice") == 0


def test_a_full_notebook_of_user_notes_refuses_the_agent_honestly(conn, monkeypatch):
    monkeypatch.setattr(notes, "MAX_NOTES", 3)
    for i in range(3):
        notes.add(conn, f"user note {i}")
    with pytest.raises(notes.NoteError):
        notes.add(conn, "agent note", source="agent")
    assert len(notes.list_notes(conn)) == 3
    # With agent notes present, the Agent's oldest goes — never the one just written.
    monkeypatch.setattr(notes, "MAX_NOTES", 4)
    first = notes.add(conn, "agent one", source="agent")
    kept = notes.add(conn, "agent two", source="agent")
    texts = [n["text"] for n in notes.list_notes(conn)]
    assert kept and "agent two" in texts and first["text"] not in texts


def test_recovery_leaves_a_reader_on_another_version_where_they_are(client, conn):
    with FakeModel([text_turn("Continued A.")]) as fake:
        _use(client, fake)
        task = store.create_task(conn, "t")
        other = store.create_turn(conn, task["id"], "Other version")
        store.set_turn_status(conn, other["id"], "completed")
        a = store.create_turn(conn, task["id"], "Direction A", parent_turn_id="")
        store.append_item(conn, task["id"], a["id"], "user_message", {"text": "Direction A"})
        store.set_turn_status(conn, a["id"], "running")
        store.set_head(conn, task["id"], other["id"])  # the reader moved to the other version
        RUNTIME.recover()
        _settle(client, task["id"])
    assert store.get_task(conn, task["id"])["head_turn_id"] == other["id"]
