"""v2.2 — live progress from the long, bounded operations.

A survey probes up to 500 buckets and an evidence import downloads up to 500
files. Both run for minutes inside one tool call, and until v2.2 the tool row
showed only a spinner. This module is the narrow bridge from the engines that
do that work to the running Execution:

- an engine reports ``(done, total, unit)`` under a KEY it knows (a run id, or
  a tool call id) — it never learns about executions or the event log;
- the tool that started the work binds that key to its own call, and the task
  runtime turns a report into a durable, throttled ``tool.progress`` event.

Facts only: counts of units the engine actually finished. Never a percentage
guessed from time, never row data. Best-effort: a failing sink never fails the
work it reports on.
"""

from __future__ import annotations

import threading
from typing import Callable

ProgressFn = Callable[[int, int, str], None]

_lock = threading.Lock()
_by_key: dict[str, ProgressFn] = {}
# task id → its running execution's sink: (call_id, tool, done, total, unit).
# A task runs one execution at a time, so the task id names it exactly — and
# unlike a client turn id it always exists (a continuation has none).
_by_task: dict[str, Callable[[str, str, int, int, str], None]] = {}


def bind(key: str, fn: ProgressFn) -> None:
    with _lock:
        _by_key[key] = fn


def unbind(key: str) -> None:
    with _lock:
        _by_key.pop(key, None)


def report(key: str | None, done: int, total: int, unit: str) -> None:
    """Called by an engine as units finish. No listener: a no-op."""
    if not key:
        return
    with _lock:
        fn = _by_key.get(key)
    if fn is None:
        return
    try:
        fn(int(done), int(total), unit)
    except Exception:  # noqa: BLE001 — progress never fails the work
        pass


def attach_task(task_id: str, sink: Callable[[str, str, int, int, str], None]) -> None:
    with _lock:
        _by_task[task_id] = sink


def detach_task(task_id: str, sink: Callable[..., None] | None = None) -> None:
    with _lock:
        if sink is None or _by_task.get(task_id) is sink:
            _by_task.pop(task_id, None)


def for_call(task_id: str | None, call_id: str, tool: str) -> ProgressFn:
    """The (done, total, unit) callback a tool hands to its engine."""
    def emit(done: int, total: int, unit: str) -> None:
        if not task_id:
            return
        with _lock:
            sink = _by_task.get(task_id)
        if sink is None:
            return
        try:
            sink(call_id, tool, done, total, unit)
        except Exception:  # noqa: BLE001
            pass
    return emit
