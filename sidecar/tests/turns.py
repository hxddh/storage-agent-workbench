"""Test helper: drive a turn through the durable runtime the way the app does.

v1.12 removed the pre-v0.94 message endpoints; tests written against
``POST /sessions/{id}/messages`` keep their shape through ``post_message``,
which submits an Execution on ``/agent-tasks``, waits for it, and returns a
response-like object carrying the same envelope the blocking shim produced.
"""

from __future__ import annotations

import time
import uuid
from typing import Any


def wait_for_completion(execution_id: str, timeout_s: float = 150.0) -> bool:
    """Block until the execution's worker finishes. True when it finished
    within the timeout. Falls back to polling the durable row when no live
    handle exists (worker in another lifetime). Test-only: the product follows
    the execution's event stream instead of blocking."""
    from app.db import connect
    from app.task_runtime import runtime, store

    handle = runtime.live_handle(execution_id)
    if handle is not None:
        return handle.done_event.wait(timeout_s)
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        conn = connect()
        try:
            row = store.get_execution(conn, execution_id)
        finally:
            conn.close()
        if row is None or row["status"] not in store.EXEC_ACTIVE_STATUSES:
            return True
        time.sleep(0.25)
    return False


class TurnResponse:
    def __init__(self, status_code: int, body: dict[str, Any]) -> None:
        self.status_code = status_code
        self._body = body

    def json(self) -> dict[str, Any]:
        return self._body

    @property
    def text(self) -> str:
        return str(self._body)

    def read(self) -> str:
        return self.text


def post_message(client, session_id: str, json: dict[str, Any] | None = None,
                 timeout_s: float = 150.0, **_ignored) -> TurnResponse:
    body = dict(json or {})
    turn_id = body.get("turn_id") or uuid.uuid4().hex
    r = client.post(f"/agent-tasks/{session_id}/executions",
                    json={"direction": body.get("content", ""), "turn_id": turn_id})
    if r.status_code >= 400:
        return TurnResponse(r.status_code, r.json())
    execution = r.json()["execution"]
    wait_for_completion(execution["id"], timeout_s)
    current = client.get(f"/agent-tasks/{session_id}/executions/{execution['id']}").json()
    status = current.get("status")
    if status == "failed":
        return TurnResponse(502, {"detail": current.get("error") or "the turn failed"})
    if status in ("queued", "running"):
        return TurnResponse(409, {"detail": "turn still in progress"})
    if status == "interrupted":
        return TurnResponse(502, {"detail": "the sidecar restarted while this turn was in flight"})
    detail = client.get(f"/sessions/{session_id}").json()
    grounding: dict[str, Any] = {}
    stopped = False
    if current.get("work_result_id"):
        wrs = client.get(f"/agent-tasks/{session_id}/work-results").json().get("work_results", [])
        wr = next((w for w in wrs if w["id"] == current["work_result_id"]), None) or {}
        grounding = wr.get("grounding") or {}
        stopped = bool(wr.get("stopped"))
    return TurnResponse(200, {
        "session_id": session_id,
        "messages": detail.get("messages", []),
        "message_total": detail.get("message_total"),
        "skills_used": grounding.get("skills_used", []),
        "evidence_used": grounding.get("evidence_used", []),
        "evidence_gaps": grounding.get("evidence_gaps", []),
        "stopped": stopped,
        "execution_id": execution["id"],
        "execution_status": status,
        "work_result_id": current.get("work_result_id"),
    })


def events_of(client, session_id: str, execution_id: str) -> list[tuple[str, dict[str, Any]]]:
    """The durable event log of one execution as (event_type, payload) pairs."""
    rows = client.get(f"/agent-tasks/{session_id}/events?after=0&limit=1000").json()
    return [(e["event_type"], e["payload"]) for e in rows.get("events", [])
            if e.get("execution_id") == execution_id]
