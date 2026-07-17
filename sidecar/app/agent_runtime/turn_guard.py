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
- ``fail(turn_id, error)`` marks the turn terminally FAILED and wakes waiters
  (with the error), so an attached fallback returns promptly instead of blocking
  the whole ``_IN_PROGRESS_WAIT_S`` and then reporting a bogus "still running".
- ``discard(turn_id)`` drops a registration entirely so a clean retry can run.

A still-running handle is never evicted by the ``_MAX`` cap: evicting it would
let a fallback see ``created=True`` and re-run the turn CONCURRENTLY with the
live worker — the exact duplication the registry prevents.

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
# session_id → the session's ACTIVE (most recent) turn handle. Used to SERIALIZE
# turns per session: a new turn must wait for the prior turn's worker to finish
# persisting before it snapshots the thread — otherwise a steer (cancel + resend)
# reads a thread missing the cancelled turn entirely, and the cancelled turn's
# late writes land AFTER the new turn's (permanently scrambled message order).
_session_active: "OrderedDict[str, TurnHandle]" = OrderedDict()


class TurnHandle:
    """In-process state of one client turn (streaming or blocking attempt)."""

    __slots__ = ("turn_id", "session_id", "done_event", "cancel_event", "payload",
                 "failed", "error")

    def __init__(self, turn_id: str, session_id: str | None):
        self.turn_id = turn_id
        self.session_id = session_id
        self.done_event = threading.Event()
        self.cancel_event = threading.Event()
        self.payload: dict[str, Any] | None = None
        self.failed = False
        self.error: str | None = None

    @property
    def done(self) -> bool:
        return self.done_event.is_set()


def _bump(od: "OrderedDict[str, Any]", key: str) -> None:
    od.move_to_end(key)
    if len(od) <= _MAX:
        return
    # Evict oldest-first, but NEVER a still-running TurnHandle (a fallback would
    # then re-run it concurrently with the live worker). `_runs` holds plain
    # dicts, which are always evictable. If everything over the cap is running,
    # allow temporary overflow rather than break the dedup guarantee.
    for k in list(od.keys()):
        if len(od) <= _MAX:
            break
        v = od[k]
        if isinstance(v, TurnHandle) and not v.done:
            continue
        del od[k]


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


def register_session_turn(session_id: str | None,
                          handle: "TurnHandle | None") -> "TurnHandle | None":
    """Make ``handle`` the session's ACTIVE turn; return the PRIOR still-live
    handle (if any) so the caller can serialize behind it.

    Contract for the caller (the turn worker): if a prior handle is returned,
    set its ``cancel_event`` (a new message while a turn runs means "redirect")
    and wait on its ``done_event`` BEFORE snapshotting the thread — so the new
    turn's context includes the prior turn's persisted messages and the thread
    order can never interleave. Bounded registry; done handles are evictable.
    """
    if not session_id or handle is None:
        return None
    with _lock:
        prior = _session_active.get(session_id)
        _session_active[session_id] = handle
        _bump(_session_active, session_id)
        if prior is not None and prior is not handle and not prior.done:
            return prior
        return None


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


def _handle_for_write(turn_id: str, session_id: str | None) -> "TurnHandle":
    """The handle to record a result/failure on, SESSION-BOUND. If the registered
    handle belongs to a DIFFERENT session (a turn_id collision between unrelated
    sessions), it is replaced with a fresh handle bound to the writer's session —
    so this session's payload is never stored on the other session's handle and
    then read back by it (``get_result`` is session-bound). Caller holds ``_lock``."""
    h = _turns.get(turn_id)
    if h is None or (h.session_id is not None and session_id is not None
                     and h.session_id != session_id):
        h = TurnHandle(turn_id, session_id)
        _turns[turn_id] = h
    return h


def set_result(turn_id: str | None, payload: dict[str, Any],
               session_id: str | None = None) -> None:
    """Record that this turn completed (so a fallback won't re-run it).

    ``session_id`` binds a handle recreated after eviction so a payload can never
    be read across sessions that reused a turn_id.
    """
    if not turn_id:
        return
    with _lock:
        h = _handle_for_write(turn_id, session_id)
        h.payload = payload
        h.done_event.set()
        _bump(_turns, turn_id)


def fail(turn_id: str | None, error: str | None = None,
         session_id: str | None = None) -> None:
    """Mark this turn terminally FAILED and wake any attached waiter.

    Unlike ``discard`` (which removes the registration silently), ``fail`` keeps
    a terminal handle whose ``done_event`` is set, so a blocking fallback parked
    on ``done_event`` wakes immediately and can surface the error instead of
    blocking the full ``_IN_PROGRESS_WAIT_S`` and then reporting "still running".
    """
    if not turn_id:
        return
    with _lock:
        h = _handle_for_write(turn_id, session_id)
        h.failed = True
        h.error = error
        h.done_event.set()
        _bump(_turns, turn_id)


def discard(turn_id: str | None) -> None:
    """Drop a turn registration (a failed attempt) so a clean retry can run.

    Resolves the handle before dropping it: a discarded turn's ``done_event`` is
    SET (so a session-serialize wait or an attached fallback parked on it wakes
    immediately instead of blocking the full timeout on an event nothing would
    ever set), and any ``_session_active`` pointer still referencing this handle
    is cleared (so the session's NEXT turn doesn't serialize behind a dead handle
    for ``_PRIOR_TURN_WAIT_S``). Without this, a clean failure on the blocking
    path — e.g. ``AgentUnavailable`` on a fresh install with no model key — left
    the session's active pointer on an unresolvable handle and every subsequent
    turn ate the 120 s prior-turn wait. A fallback that had already attached wakes
    to a prompt, retryable 409 rather than a 150 s hang.
    """
    if not turn_id:
        return
    with _lock:
        h = _turns.pop(turn_id, None)
        if h is not None:
            h.done_event.set()
            for sid, active in list(_session_active.items()):
                if active is h:
                    del _session_active[sid]


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
        _session_active.clear()


__all__ = ["TurnHandle", "begin", "register_session_turn", "get_handle",
           "get_result", "set_result", "fail", "discard", "get_run", "set_run"]
