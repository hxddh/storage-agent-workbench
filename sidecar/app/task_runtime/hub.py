"""In-process live layer over the durable execution event log.

The DURABLE truth is ``execution_events`` in SQLite — a subscriber can always
replay from any sequence number, across reconnects and process restarts. This
hub adds only the two things a durable log cannot give:

- transient ANSWER DELTAS for a live execution (sanitized text the user watches
  arrive; the persisted Work Result is the durable form, so deltas are never
  written to the log), and
- prompt wakeups, so a live subscriber is notified when new durable events land
  instead of pure polling.

Best-effort and process-local by design: losing this state loses nothing
durable. Bounded everywhere.
"""

from __future__ import annotations

import threading

_MAX_DELTA_CHARS = 400_000       # per execution; beyond this the tail wins
_MAX_RETAINED = 128              # finished executions kept for late re-attach
_lock = threading.Lock()


class _Entry:
    __slots__ = ("delta_text", "delta_dropped", "done", "cond")

    def __init__(self) -> None:
        self.delta_text = ""       # accumulated sanitized delta text
        self.delta_dropped = 0     # chars evicted from the head (never silent)
        self.done = False
        self.cond = threading.Condition(_lock)


_entries: dict[str, _Entry] = {}


def _get(execution_id: str, create: bool = False) -> _Entry | None:
    entry = _entries.get(execution_id)
    if entry is None and create:
        entry = _Entry()
        _entries[execution_id] = entry
        _evict_done_locked()
    return entry


def _evict_done_locked() -> None:
    while len(_entries) > _MAX_RETAINED:
        victim = next((k for k, e in _entries.items() if e.done), None)
        if victim is None:
            break
        del _entries[victim]


def open_live(execution_id: str) -> None:
    with _lock:
        _get(execution_id, create=True)


def push_delta(execution_id: str, text: str) -> None:
    """Append sanitized delta text for a live execution (bounded, tail wins)."""
    if not text:
        return
    with _lock:
        entry = _get(execution_id, create=True)
        assert entry is not None
        entry.delta_text += text
        overflow = len(entry.delta_text) - _MAX_DELTA_CHARS
        if overflow > 0:
            entry.delta_text = entry.delta_text[overflow:]
            entry.delta_dropped += overflow
        entry.cond.notify_all()


def notify(execution_id: str) -> None:
    """Wake subscribers: new durable events exist for this execution."""
    with _lock:
        entry = _entries.get(execution_id)
        if entry is not None:
            entry.cond.notify_all()


def mark_done(execution_id: str) -> None:
    with _lock:
        entry = _entries.get(execution_id)
        if entry is not None:
            entry.done = True
            entry.cond.notify_all()


def delta_snapshot(execution_id: str, cursor: int) -> tuple[str, int, int]:
    """(new_text, next_cursor, dropped_before_cursor) for the live delta stream.

    ``cursor`` is a LOGICAL character offset across the whole delta stream, so
    it stays valid after head eviction. Unknown execution → nothing (the caller
    still has the durable log, which is the part that matters)."""
    with _lock:
        entry = _entries.get(execution_id)
        if entry is None:
            return "", cursor, 0
        start_logical = entry.delta_dropped
        end_logical = start_logical + len(entry.delta_text)
        if cursor >= end_logical:
            return "", cursor, 0
        dropped = max(0, start_logical - cursor)
        text = entry.delta_text[max(0, cursor - start_logical):]
        return text, end_logical, dropped


def is_done(execution_id: str) -> bool:
    with _lock:
        entry = _entries.get(execution_id)
        return entry.done if entry is not None else True


def _reset_for_tests() -> None:
    with _lock:
        _entries.clear()
