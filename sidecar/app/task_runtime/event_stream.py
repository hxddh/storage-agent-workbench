"""SSE over the durable execution event log.

The stream is a VIEW, never the owner: durable events are read from SQLite from
any ``after`` cursor (so a reconnect, reload, or new client replays exactly
what it missed), live answer deltas ride along from the in-process hub, and
closing the stream affects nothing. Every durable frame carries ``id: <seq>``
so Last-Event-ID-style resumption is one query parameter.

Frame vocabulary (product stream):
  id: <seq> / event: <event_type> / data: {seq, event_type, payload, created_at}
  event: delta / data: {text}                     (transient, no id)
  event: end   / data: {status}                   (the execution left the live set)
  : keepalive                                     (comment heartbeat)

Since v1.12 this is the ONLY live protocol: the pre-v0.94 message stream and
its vocabulary are gone.
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any, AsyncIterator

from ..db import connect
from . import hub, store

# The follower sleeps on a hub wakeup, never on a poll; this bound only paces
# the keepalive comment and the settled re-check when nothing arrives.
_HEARTBEAT_S = 15.0
_SETTLE_RECHECK_S = 2.0
_STREAM_MAX_S = 3600.0

# Statuses after which no further durable events will be produced by the
# execution itself (decision resolution may still append later — a reconnecting
# client picks those up by replay).
_SETTLED = (store.EXEC_COMPLETED, store.EXEC_FAILED, store.EXEC_CANCELLED,
            store.EXEC_INTERRUPTED, store.EXEC_WAITING)


def _sse(event: str, data: dict[str, Any], seq: int | None = None) -> str:
    head = f"id: {seq}\n" if seq is not None else ""
    return f"{head}event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _frame(ev: dict[str, Any]) -> str:
    return _sse(ev["event_type"],
                {"seq": ev["seq"], "execution_id": ev["execution_id"],
                 "event_type": ev["event_type"], "payload": ev["payload"],
                 "created_at": ev["created_at"]}, seq=ev["seq"])


async def execution_frames(execution_id: str, after_seq: int = 0,
                           include_deltas: bool = True) -> AsyncIterator[str]:
    """Yield SSE frames for one execution: durable replay from ``after_seq``,
    then live follow until the execution settles.

    Live, transient deltas and durable events are interleaved in the order
    the worker produced them (the hub records where in the delta stream each
    durable event landed), so a tool row never arrives after text the model
    wrote once the tool had returned, and a segment's held-back tail never
    arrives after the ``message.completed`` that closed it."""
    conn = connect()
    loop = asyncio.get_running_loop()
    wake = asyncio.Event()
    hub.subscribe(execution_id, loop, wake)
    try:
        cursor = int(after_seq)
        delta_cursor = -1  # -1 → start from the beginning of the live buffer
        idle = 0.0
        started = time.monotonic()

        def _durable(up_to: int | None = None) -> list[dict[str, Any]]:
            nonlocal cursor
            events = store.list_events(conn, execution_id, after_seq=cursor, up_to_seq=up_to)
            for ev in events:
                cursor = ev["seq"]
            return events

        def _drain() -> list[str]:
            """One ordered pass: hub parts (text / markers) then whatever
            durable events have no marker (replay, or a marker that fell off)."""
            nonlocal delta_cursor
            out: list[str] = []
            if include_deltas:
                if delta_cursor < 0:
                    # First read: skip what streamed before we attached — the
                    # durable Work Result carries the full text; deltas are
                    # only the live tail.
                    _, delta_cursor, _ = hub.delta_snapshot(execution_id, 0)
                parts, delta_cursor, _dropped = hub.ordered_snapshot(execution_id, delta_cursor)
                for kind, value in parts:
                    if kind == "text":
                        if value:
                            out.append(_sse("delta", {"text": str(value)}))
                    else:
                        out.extend(_frame(ev) for ev in _durable(int(value)))  # type: ignore[arg-type]
            out.extend(_frame(ev) for ev in _durable())
            return out

        while True:
            wake.clear()
            frames = _drain()
            for frame in frames:
                yield frame
            if frames:
                idle = 0.0
                continue
            row = store.get_execution(conn, execution_id)
            settled = row is None or row["status"] in _SETTLED
            if settled and hub.is_done(execution_id):
                # One last drain so a final delta/event racing the status read
                # is not lost, then close explicitly.
                for frame in _drain():
                    yield frame
                yield _sse("end", {"status": row["status"] if row else "unknown"})
                return
            if time.monotonic() - started >= _STREAM_MAX_S:
                yield _sse("end", {"status": "stream_timeout"})
                return
            # Sleep until the hub wakes us (a delta, a durable event, done), or
            # the heartbeat bound elapses. A `waiting` execution has a live
            # worker, so its wakeups arrive the same way; only an execution
            # settled by another process is re-checked on the bound.
            bound = _SETTLE_RECHECK_S if settled else _HEARTBEAT_S
            try:
                await asyncio.wait_for(wake.wait(), timeout=bound)
                idle = 0.0
            except asyncio.TimeoutError:
                idle += bound
                if idle >= _HEARTBEAT_S:
                    idle = 0.0
                    yield ": keepalive\n\n"
    finally:
        hub.unsubscribe(execution_id, wake)
        conn.close()
