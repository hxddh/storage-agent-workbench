"""In-process event bus for run SSE streaming.

Deliberately simple and dependency-free (no Redis/Celery/queue): events for an
active run are buffered in memory and replayed to any SSE subscriber from the
beginning, so a client that connects mid-run (or just after it finishes) still
sees the full timeline. Best-effort and local-only by design — buffers do not
survive a process restart.

Events must never contain secrets; callers pass already-sanitized payloads.
"""

from __future__ import annotations

import asyncio
import json
import threading
from typing import Any

_POLL_INTERVAL_S = 0.1
# Send a comment heartbeat after this much silence so a genuinely slow-but-alive
# run (e.g. account_discovery pausing on one big bucket) doesn't look idle and
# get dropped — the stream stays open until the run is marked done.
_HEARTBEAT_S = 15.0
# Absolute backstop: stop streaming a run that never marks done (e.g. a hard
# crash mid-run left no done flag), so the generator can't linger forever.
_STREAM_MAX_S = 1800.0
# Per-run buffer cap: a chatty run (e.g. account_discovery over hundreds of
# buckets) must not grow its event list without bound. Beyond this, the oldest
# events are dropped and an `offset` tracks how many, so cursor math stays
# correct — a subscriber that reconnects far behind simply resumes at the window.
_MAX_EVENTS_PER_RUN = 4000
# Cap on how many finished runs' buffers we retain. Once exceeded, the oldest
# done runs are evicted so completed-run buffers can't accumulate for the life of
# the process. Active (not-done) runs are never evicted.
_MAX_RETAINED_RUNS = 256


class EventBus:
    def __init__(self) -> None:
        self._runs: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()

    def _new_entry(self) -> dict[str, Any]:
        return {"events": [], "offset": 0, "done": False}

    def _evict_done_locked(self) -> None:
        # Called under _lock. Drop oldest finished runs first (dict preserves
        # insertion order); never touch runs still streaming.
        while len(self._runs) > _MAX_RETAINED_RUNS:
            victim = next((rid for rid, e in self._runs.items() if e["done"]), None)
            if victim is None:
                break  # everything still active — don't evict a live run
            del self._runs[victim]

    def create(self, run_id: str) -> None:
        with self._lock:
            self._runs.setdefault(run_id, self._new_entry())
            self._evict_done_locked()

    def publish(self, run_id: str, event: dict[str, Any]) -> None:
        with self._lock:
            entry = self._runs.setdefault(run_id, self._new_entry())
            entry["events"].append(event)
            overflow = len(entry["events"]) - _MAX_EVENTS_PER_RUN
            if overflow > 0:
                del entry["events"][:overflow]
                entry["offset"] += overflow

    def mark_done(self, run_id: str) -> None:
        with self._lock:
            entry = self._runs.setdefault(run_id, self._new_entry())
            entry["done"] = True

    def snapshot(self, run_id: str, cursor: int) -> tuple[list[dict[str, Any]], int, bool]:
        """Return (events after cursor, next_cursor, done).

        ``cursor`` is a LOGICAL index across the run's whole event stream (not a
        list index), so it stays valid even after old events are evicted. Unknown
        run is treated as done.
        """
        with self._lock:
            entry = self._runs.get(run_id)
            if entry is None:
                return [], cursor, True
            offset = entry["offset"]
            start = max(cursor - offset, 0)
            evs = list(entry["events"][start:])
            next_cursor = offset + len(entry["events"])
            return evs, next_cursor, bool(entry["done"])

    def all_events(self, run_id: str) -> list[dict[str, Any]]:
        with self._lock:
            entry = self._runs.get(run_id)
            return list(entry["events"]) if entry else []


# Singleton used across the app.
bus = EventBus()


async def sse_stream(run_id: str):
    """Async generator yielding SSE 'data:' frames until the run is done.

    Stays open while the run is active even across long silences (a heartbeat
    keeps the connection alive), so a slow run's timeline keeps updating. Ends
    promptly once the run is marked done; an absolute backstop prevents a
    never-marked-done run from lingering forever.
    """
    cursor = 0
    idle = 0.0
    total = 0.0
    while True:
        events, cursor, done = bus.snapshot(run_id, cursor)
        for event in events:
            yield f"data: {json.dumps(event)}\n\n"
        if events:
            idle = 0.0
            continue
        if done:
            break
        await asyncio.sleep(_POLL_INTERVAL_S)
        idle += _POLL_INTERVAL_S
        total += _POLL_INTERVAL_S
        if idle >= _HEARTBEAT_S:
            idle = 0.0
            yield ": keepalive\n\n"  # SSE comment; ignored by EventSource
        if total >= _STREAM_MAX_S:
            break
