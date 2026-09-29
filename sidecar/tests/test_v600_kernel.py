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
