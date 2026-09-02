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


_MAX_MARKERS = 4096              # per execution; older markers fall off the head


class _Entry:
    __slots__ = ("delta_text", "delta_dropped", "done", "cond", "markers")

    def __init__(self) -> None:
        self.delta_text = ""       # accumulated sanitized delta text
        self.delta_dropped = 0     # chars evicted from the head (never silent)
        self.done = False
        self.cond = threading.Condition(_lock)
        # (logical delta offset, durable seq): "durable events up to `seq`
        # were appended when the delta stream stood at `offset`". Lets a
        # subscriber interleave transient deltas and durable events in the
        # order they really happened (a tool row never lands after text the
        # model wrote once the tool had returned).
        self.markers: list[tuple[int, int]] = []


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


def notify(execution_id: str, seq: int | None = None) -> None:
    """Wake subscribers: new durable events exist for this execution. With
    ``seq``, also record WHERE in the delta stream that event landed."""
    with _lock:
        entry = _entries.get(execution_id)
        if entry is not None:
            if seq is not None:
                offset = entry.delta_dropped + len(entry.delta_text)
                entry.markers.append((offset, int(seq)))
                if len(entry.markers) > _MAX_MARKERS:
                    del entry.markers[: len(entry.markers) - _MAX_MARKERS]
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


def ordered_snapshot(execution_id: str, cursor: int) -> tuple[list[tuple[str, object]], int, int]:
    """Like ``delta_snapshot`` but keeps the durable-event markers in place:
    returns ``([("text", str) | ("mark", seq), ...], next_cursor, dropped)``.
    A subscriber yields text parts as deltas and, at each mark, the durable
    events up to that seq — the order the worker produced them."""
    with _lock:
        entry = _entries.get(execution_id)
        if entry is None:
            return [], cursor, 0
        start_logical = entry.delta_dropped
        end_logical = start_logical + len(entry.delta_text)
        dropped = max(0, start_logical - cursor)
        pos = max(cursor, start_logical)
        parts: list[tuple[str, object]] = []
        for offset, seq in entry.markers:
            if offset < cursor:
                continue
            if offset > pos:
                parts.append(("text", entry.delta_text[pos - start_logical: offset - start_logical]))
                pos = offset
            parts.append(("mark", seq))
        if end_logical > pos:
            parts.append(("text", entry.delta_text[pos - start_logical:]))
        # Markers already consumed are not needed again by anyone reading past them.
        return parts, max(cursor, end_logical), dropped


def is_done(execution_id: str) -> bool:
    with _lock:
        entry = _entries.get(execution_id)
        return entry.done if entry is not None else True


def _reset_for_tests() -> None:
    with _lock:
        _entries.clear()
