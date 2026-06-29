"""Per-turn idempotency guard for session message turns (in-process).

A session turn can be attempted twice: the streaming endpoint runs it, and if the
SSE connection breaks the frontend falls back to the blocking endpoint with the
SAME client ``turn_id``. Without dedup the fallback re-runs the agent — which
(a) re-persists the turn if the stream had actually completed server-side
(duplicate user+assistant messages), and (b) re-executes any inline read-only run
the agent had already started during the failed attempt (duplicate run + S3
calls + timeline entries).

This guard, keyed by the client ``turn_id``, lets the blocking fallback:
- short-circuit a turn the stream already completed (return the persisted result
  instead of re-running), and
- reuse an inline run the (failed) stream already created, instead of creating a
  second one.

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
_results: "OrderedDict[str, dict[str, Any]]" = OrderedDict()
_runs: "OrderedDict[str, dict[str, str]]" = OrderedDict()


def _bump(od: "OrderedDict[str, Any]", key: str) -> None:
    od.move_to_end(key)
    while len(od) > _MAX:
        od.popitem(last=False)


def get_result(turn_id: str | None) -> dict[str, Any] | None:
    """The completed result of a prior attempt of this turn, if any."""
    if not turn_id:
        return None
    with _lock:
        r = _results.get(turn_id)
        if r is not None:
            _results.move_to_end(turn_id)
        return r


def set_result(turn_id: str | None, payload: dict[str, Any]) -> None:
    """Record that this turn completed (so a fallback won't re-run it)."""
    if not turn_id:
        return
    with _lock:
        _results[turn_id] = payload
        _bump(_results, turn_id)


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
        _results.clear()
        _runs.clear()


__all__ = ["get_result", "set_result", "get_run", "set_run"]
