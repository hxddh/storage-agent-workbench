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


class EventBus:
    def __init__(self) -> None:
        self._runs: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()

    def create(self, run_id: str) -> None:
        with self._lock:
            self._runs.setdefault(run_id, {"events": [], "done": False})

    def publish(self, run_id: str, event: dict[str, Any]) -> None:
        with self._lock:
            entry = self._runs.setdefault(run_id, {"events": [], "done": False})
            entry["events"].append(event)

    def mark_done(self, run_id: str) -> None:
        with self._lock:
            entry = self._runs.setdefault(run_id, {"events": [], "done": False})
            entry["done"] = True

    def snapshot(self, run_id: str, cursor: int) -> tuple[list[dict[str, Any]], bool]:
        """Return (events after cursor, done). Unknown run is treated as done."""
        with self._lock:
            entry = self._runs.get(run_id)
            if entry is None:
                return [], True
            return list(entry["events"][cursor:]), bool(entry["done"])

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
        events, done = bus.snapshot(run_id, cursor)
        for event in events:
            cursor += 1
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
