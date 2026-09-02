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

``legacy_frames`` translates the same durable stream into the pre-v0.94
``delta``/``tool``/``done``/``error`` vocabulary so the compatibility
``/sessions/{id}/messages/stream`` endpoint keeps its wire contract while the
runtime underneath is the durable one.
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any, AsyncIterator

from ..db import connect
from . import hub, store

_POLL_S = 0.12
_HEARTBEAT_S = 15.0
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
            await asyncio.sleep(_POLL_S)
            idle += _POLL_S
            if idle >= _HEARTBEAT_S:
                idle = 0.0
                yield ": keepalive\n\n"
    finally:
        conn.close()


# --- legacy translation --------------------------------------------------------


def _legacy_done_payload(conn: Any, payload: dict[str, Any]) -> dict[str, Any]:
    """Rebuild the pre-v0.94 `done` event body from the durable Work Result."""
    wr = store.get_work_result(conn, str(payload.get("work_result_id") or "")) or {}
    grounding = wr.get("grounding") or {}
    return {
        "message_id": payload.get("message_id"),
        "proposed_actions": [],
        "evidence_used": grounding.get("evidence_used", []),
        "evidence_gaps": grounding.get("evidence_gaps", []),
        "skills_used": grounding.get("skills_used", []),
        "stopped": bool(payload.get("stopped")),
        "metrics": payload.get("metrics") or {},
        # New, additive: the durable ids a modern client can hang state on.
        "execution_id": payload.get("execution_id"),
        "work_result_id": payload.get("work_result_id"),
    }


async def legacy_frames(execution_id: str) -> AsyncIterator[str]:
    """The same durable stream, spoken in the pre-v0.94 wire vocabulary
    (`delta` / `tool` / `done` / `error`) for the compatibility endpoint."""
    conn = connect()
    try:
        async for frame in execution_frames(execution_id, include_deltas=True):
            if frame.startswith(":"):
                yield frame
                continue
            event, data = _parse_frame(frame)
            if event == "delta":
                yield _sse("delta", {"text": data.get("text", "")})
            elif event == "message.completed":
                # No legacy equivalent: the legacy client rebuilds the answer
                # from the Work Result on `done`.
                continue
            elif event in ("tool.started", "tool.completed"):
                payload = dict(data.get("payload") or {})
                payload["status"] = "started" if event == "tool.started" else "completed"
                yield _sse("tool", payload)
            elif event == "steer.applied":
                yield _sse("tool", {"tool": "user_steer", "target": "",
                                    "result": (data.get("payload") or {}).get("text", ""),
                                    "ok": True, "status": "completed"})
            elif event == "execution.status":
                payload = data.get("payload") or {}
                status = payload.get("status")
                if status == store.EXEC_FAILED:
                    yield _sse("error", {"detail": payload.get("error")
                                         or "the execution failed"})
                elif status in (store.EXEC_COMPLETED, store.EXEC_WAITING,
                                store.EXEC_CANCELLED) and payload.get("work_result_id"):
                    done = _legacy_done_payload(conn, {**payload,
                                                       "execution_id": execution_id})
                    yield _sse("done", done)
                elif status == store.EXEC_INTERRUPTED:
                    yield _sse("error", {"detail": "the sidecar restarted while this "
                                                   "execution was in flight"})
            elif event == "end":
                return
            # Other structured events (queued/running/decision.*/context.*) have
            # no legacy equivalent; the legacy client derives nothing from them.
    finally:
        conn.close()


def _parse_frame(frame: str) -> tuple[str, dict[str, Any]]:
    event, data = "", {}
    for line in frame.splitlines():
        if line.startswith("event: "):
            event = line[len("event: "):]
        elif line.startswith("data: "):
            try:
                data = json.loads(line[len("data: "):])
            except (TypeError, ValueError):
                data = {}
    return event, data
