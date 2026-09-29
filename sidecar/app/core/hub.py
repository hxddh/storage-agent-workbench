"""Live fan-out for task streams (process-local, best-effort).

Durable truth is the `items` table; a follower can always replay from a seq.
The hub adds what a table cannot: pushing to open streams the moment an item
lands, and the ephemeral live layer — text deltas of the segment the model is
writing right now, and the task's current state. Losing the hub loses nothing
durable.

Thread-safe: the agent runs on its own event loop thread, SSE followers on the
server's loop. Each subscriber owns a bounded queue; a subscriber that falls
behind drops ephemeral events and re-syncs from the durable seq.
"""

from __future__ import annotations

import asyncio
import threading
from typing import Any

_QUEUE_MAX = 2048
_MAX_LIVE_CHARS = 200_000
_lock = threading.Lock()


class _Sub:
    __slots__ = ("loop", "queue")

    def __init__(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop
        self.queue: asyncio.Queue[tuple[str, Any]] = asyncio.Queue(maxsize=_QUEUE_MAX)


_subs: dict[str, list[_Sub]] = {}
# The segment each task's model is writing right now: {turn_id, segment_id, text}.
_live: dict[str, dict[str, Any]] = {}
_global: list[_Sub] = []  # followers of every task's state (the sidebar)


def subscribe(task_id: str | None, loop: asyncio.AbstractEventLoop) -> _Sub:
    sub = _Sub(loop)
    with _lock:
        if task_id is None:
            _global.append(sub)
        else:
            _subs.setdefault(task_id, []).append(sub)
    return sub


def subscribe_with_live(task_id: str, loop: asyncio.AbstractEventLoop) -> tuple[_Sub, dict[str, Any] | None]:
    """Subscribe and read the live segment atomically (deltas publish under the same lock)."""
    sub = _Sub(loop)
    with _lock:
        _subs.setdefault(task_id, []).append(sub)
        live = _live.get(task_id)
        return sub, (dict(live) if live else None)


def unsubscribe(task_id: str | None, sub: _Sub) -> None:
    with _lock:
        if task_id is None:
            if sub in _global:
                _global.remove(sub)
            return
        subs = _subs.get(task_id, [])
        if sub in subs:
            subs.remove(sub)
        if not subs:
            _subs.pop(task_id, None)


def _deliver(sub: _Sub, event: tuple[str, Any]) -> None:
    def put() -> None:
        try:
            sub.queue.put_nowait(event)
        except asyncio.QueueFull:
            pass  # the follower re-syncs from the durable seq
    try:
        sub.loop.call_soon_threadsafe(put)
    except RuntimeError:
        pass  # its loop is gone; it will unsubscribe


def publish(task_id: str, kind: str, data: Any) -> None:
    with _lock:
        targets = list(_subs.get(task_id, []))
    for sub in targets:
        _deliver(sub, (kind, data))


def publish_global(kind: str, data: Any) -> None:
    with _lock:
        targets = list(_global)
    for sub in targets:
        _deliver(sub, (kind, data))


def item(task_id: str, item_: dict[str, Any]) -> None:
    publish(task_id, "item", item_)


def delta(task_id: str, turn_id: str, segment_id: str, text: str) -> None:
    if not text:
        return
    event = ("delta", {"turn_id": turn_id, "segment_id": segment_id, "text": text})
    with _lock:
        live = _live.get(task_id)
        if live is None or live.get("segment_id") != segment_id:
            live = {"turn_id": turn_id, "segment_id": segment_id, "text": ""}
            _live[task_id] = live
        live["text"] = (live["text"] + text)[-_MAX_LIVE_CHARS:]
        # Queued under the same lock as the live text, so a new follower sees
        # each delta exactly once (in its snapshot or in its queue).
        targets = list(_subs.get(task_id, []))
        for sub in targets:
            _deliver(sub, event)


def close_segment(task_id: str, segment_id: str) -> None:
    with _lock:
        live = _live.get(task_id)
        if live is not None and live.get("segment_id") == segment_id:
            _live.pop(task_id, None)


def live_snapshot(task_id: str) -> dict[str, Any] | None:
    with _lock:
        live = _live.get(task_id)
        return dict(live) if live else None


def turn(task_id: str, data: dict[str, Any]) -> None:
    publish(task_id, "turn", data)


def state(task_id: str, data: dict[str, Any]) -> None:
    publish(task_id, "state", data)
    publish_global("task", {"task_id": task_id, **data})


def _reset_for_tests() -> None:
    with _lock:
        _subs.clear()
        _live.clear()
        _global.clear()
