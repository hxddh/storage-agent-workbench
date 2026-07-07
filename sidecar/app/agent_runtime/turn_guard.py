"""Per-turn registry for session message turns (in-process).

A session turn can be attempted twice: the streaming endpoint runs it, and if
the SSE connection breaks the frontend falls back to the blocking endpoint with
the SAME client ``turn_id``. Without a registry the fallback re-runs the agent
concurrently with the still-alive streaming worker — duplicate user+assistant
messages, duplicate inline runs, double model spend.

The registry, keyed by the client ``turn_id``, tracks each turn's lifecycle:

- ``begin(turn_id, session_id)`` registers a RUNNING turn and returns its
  :class:`TurnHandle` (``done_event`` to wait on completion, ``cancel_event``
  the user can set to stop it). If the same turn is already registered for the
  same session, the existing handle is returned with ``created=False`` so the
  caller ATTACHES (waits) instead of re-running.
- ``set_result(turn_id, payload)`` marks the turn done and wakes waiters.
- ``get_result(turn_id, session_id)`` is SESSION-BOUND: a result recorded for
  another session's turn is never returned (fixes the cross-session cache
  collision when two sessions reuse a turn_id).
- ``discard(turn_id)`` drops a failed attempt so a clean retry can run.

Process-local and best-effort by design: the fallback always happens within the
same sidecar process seconds later, so in-memory state is sufficient and nothing
is persisted. Bounded to the most recent ``_MAX`` turns.
"""

from __future__ import annotations

import threading
from collections import OrderedDict
from typing import Any

_MAX = 256
_lock = threading.RLock()
_turns: "OrderedDict[str, TurnHandle]" = OrderedDict()
_runs: "OrderedDict[str, dict[str, str]]" = OrderedDict()


class TurnHandle:
    """In-process state of one client turn (streaming or blocking attempt)."""

    __slots__ = ("turn_id", "session_id", "done_event", "cancel_event", "payload")

    def __init__(self, turn_id: str, session_id: str | None):
        self.turn_id = turn_id
        self.session_id = session_id
        self.done_event = threading.Event()
        self.cancel_event = threading.Event()
        self.payload: dict[str, Any] | None = None

    @property
    def done(self) -> bool:
        return self.done_event.is_set()


def _bump(od: "OrderedDict[str, Any]", key: str) -> None:
    od.move_to_end(key)
    while len(od) > _MAX:
        od.popitem(last=False)


def begin(turn_id: str | None, session_id: str | None) -> tuple["TurnHandle | None", bool]:
    """Register a turn as running. Returns ``(handle, created)``.

    ``created=False`` means this turn is already registered for the SAME session
    (running or completed) — the caller must attach to the existing handle
    (wait on ``done_event`` / read the payload) instead of re-running the turn.
    A same-turn_id registration from a DIFFERENT session is a collision between
    unrelated turns and is replaced by a fresh handle.
    """
    if not turn_id:
        return None, True
    with _lock:
        h = _turns.get(turn_id)
        if h is not None and h.session_id == session_id:
            _bump(_turns, turn_id)
            return h, False
        h = TurnHandle(turn_id, session_id)
        _turns[turn_id] = h
        _bump(_turns, turn_id)
        return h, True


def get_handle(turn_id: str | None, session_id: str | None = None) -> "TurnHandle | None":
    """The registered handle for this turn, if any (session-bound when given)."""
    if not turn_id:
        return None
    with _lock:
        h = _turns.get(turn_id)
        if h is None:
            return None
        if session_id is not None and h.session_id is not None and h.session_id != session_id:
            return None
        _turns.move_to_end(turn_id)
        return h


def get_result(turn_id: str | None, session_id: str | None = None) -> dict[str, Any] | None:
    """The completed result of a prior attempt of this turn, if any.

    Session-bound: a payload recorded for a different session's turn (turn_id
    collision) is never returned.
    """
    h = get_handle(turn_id, session_id)
    if h is None or not h.done:
        return None
    return h.payload


def set_result(turn_id: str | None, payload: dict[str, Any]) -> None:
    """Record that this turn completed (so a fallback won't re-run it)."""
    if not turn_id:
        return
    with _lock:
        h = _turns.get(turn_id)
        if h is None:
            h = TurnHandle(turn_id, None)
            _turns[turn_id] = h
        h.payload = payload
        h.done_event.set()
        _bump(_turns, turn_id)


def discard(turn_id: str | None) -> None:
    """Drop a turn registration (a failed attempt) so a clean retry can run."""
    if not turn_id:
        return
    with _lock:
        _turns.pop(turn_id, None)


def get_run(turn_id: str | None, key: str) -> str | None:
    """The run_id an inline run with ``key`` already created in this turn, if any."""
    if not turn_id:
        return None
    with _lock:
        return (_runs.get(turn_id) or {}).get(key)


def set_run(turn_id: str | None, key: str, run_id: str) -> None:
    """Remember that this turn created an inline run with ``key`` → ``run_id``."""
    if not turn_id:
        return
    with _lock:
        d = _runs.get(turn_id)
        if d is None:
            d = {}
            _runs[turn_id] = d
        d[key] = run_id
        _bump(_runs, turn_id)


def _reset_for_tests() -> None:
    with _lock:
        _turns.clear()
        _runs.clear()


__all__ = ["TurnHandle", "begin", "get_handle", "get_result", "set_result",
           "discard", "get_run", "set_run"]
