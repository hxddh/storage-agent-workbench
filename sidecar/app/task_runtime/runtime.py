"""The Agent Task execution supervisor — the ONE submission lifecycle.

Ownership moves here from the HTTP layer: an Execution is a durable row driven
by a background worker keyed by durable task identity. The HTTP request that
delegated the work merely OBSERVES it (through the durable event log); a
dropped SSE, a task switch, a reload — none of them touch the worker. A sidecar
restart is the only thing that can kill an execution, and recovery then stamps
it ``interrupted`` durably instead of pretending nothing was running.

Lifecycle:

    submit()  → queued row (+ event) → per-task worker → running (+ event)
              → model loop streams (tool events persisted, deltas via hub)
              → final: Direction + steers + Work Result persisted, first-class
                Decisions opened, typed context versioned
              → completed | waiting (a gated Decision is pending)
              | failed | cancelled          — every transition a durable event.

Steer acts ON the current execution: the text is pushed into the running model
loop and injected at the next tool boundary (see session_agent.SteerQueue). A
steer that arrives after the loop stopped calling tools is not lost — it is
carried into an automatic follow-up execution.

Single agent, unchanged security floor: the worker drives the same
session_agent loop (read-only tools, sanitized/bounded context, secrets
server-side only). This module adds durability and ownership, not capability.
"""

from __future__ import annotations

import sqlite3
import threading
import time
from typing import Any

from .. import audit, config
from ..agent_runtime import session_agent
from ..agent_runtime.agent_service import AgentUnavailable, get_model_credentials
from ..db import connect
from ..repositories import session_activity
from ..repositories import session_datasets as sds_repo
from ..repositories import sessions as sessions_repo
from ..security.redaction import redact_text
from ..sessions import summary_builder
from . import context as task_context
from . import hub, store

_CONTEXT_MESSAGES = session_agent._MAX_MESSAGES_CEIL


def _safe_err(exc: object) -> str:
    return config.scrub_paths(redact_text(str(exc)))


class LiveExecution:
    """In-process handle for one running execution (signals only — all durable
    state lives in the store)."""

    __slots__ = ("execution_id", "task_id", "cancel_event", "steer_queue", "done_event")

    def __init__(self, execution_id: str, task_id: str) -> None:
        self.execution_id = execution_id
        self.task_id = task_id
        self.cancel_event = threading.Event()
        self.steer_queue = session_agent.SteerQueue()
        self.done_event = threading.Event()


_lock = threading.RLock()
_live: dict[str, LiveExecution] = {}          # execution_id → handle
_workers: dict[str, threading.Thread] = {}    # task_id → drain thread

# Test seam: swap the model-loop driver without monkeypatching deep internals.
# Signature: (spec: dict) -> async-iterable of (kind, data) — see _drive_stream.


def live_handle(execution_id: str) -> LiveExecution | None:
    with _lock:
        return _live.get(execution_id)


# --- submission ----------------------------------------------------------------


def submit(conn: sqlite3.Connection, task_id: str, direction: str,
           turn_id: str | None = None, *, kind: str = "direction",
           resumed_from: str | None = None,
           require_model: bool = True) -> dict[str, Any]:
    """Create (or attach to) a durable execution for this Direction and make
    sure the task's worker is draining. Returns the execution row.

    Idempotent on (task, turn_id): a duplicate submit — the streaming client's
    fallback, a retry after a dropped response — attaches to the existing
    execution instead of re-running it. That guarantee is now a UNIQUE index,
    not an in-process registry.
    """
    if store.get_task(conn, task_id) is None:
        # The task row is 1:1 with the session; ensure it exists for sessions
        # created before the runtime (or by direct SQL in tests).
        row = conn.execute("SELECT * FROM sessions WHERE id = ?", (task_id,)).fetchone()
        if row is None:
            raise KeyError("task not found")
        store.ensure_task(conn, task_id, row["title"], row["goal"])
    if require_model:
        # Fail fast with a clean, actionable error while the user is looking —
        # a queued execution that dies later on "no model key" is worse UX than
        # an immediate 422. Availability is re-checked at run time regardless.
        get_model_credentials(conn)  # raises AgentUnavailable
    if turn_id:
        existing = store.get_execution_by_turn(conn, task_id, turn_id)
        if existing is not None:
            return existing
    try:
        execution = store.create_execution(conn, task_id, direction, turn_id,
                                           kind=kind, resumed_from=resumed_from)
    except sqlite3.IntegrityError:
        # Two racing submits with the same turn_id: the index arbitrates.
        existing = store.get_execution_by_turn(conn, task_id, turn_id or "")
        if existing is None:
            raise
        return existing
    store.append_event(conn, execution["id"], task_id, "execution.status",
                       {"status": store.EXEC_QUEUED, "kind": kind,
                        **({"resumed_from": resumed_from} if resumed_from else {})},
                       commit=False)
    store.set_task_status(conn, task_id, store.TASK_WORKING,
                          active_execution_id=execution["id"])
    audit.record(conn, "task.execution.submitted",
                 {"task_id": task_id, "execution_id": execution["id"], "kind": kind},
                 run_id=None, session_id=task_id)
    conn.commit()
    with _lock:
        _live[execution["id"]] = LiveExecution(execution["id"], task_id)
    hub.open_live(execution["id"])
    _ensure_worker(task_id)
    return execution


def steer(conn: sqlite3.Connection, task_id: str, text: str) -> dict[str, Any] | None:
    """Steer the task's CURRENT execution. Returns the execution row steered,
    or None when nothing is active (the caller should submit instead)."""
    execution = store.active_execution(conn, task_id)
    if execution is None:
        return None
    store.bump_steer_count(conn, execution["id"])
    store.append_event(conn, execution["id"], task_id, "steer.received",
                       {"text": redact_text(str(text or ""))[:400]}, commit=False)
    audit.record(conn, "task.execution.steer",
                 {"task_id": task_id, "execution_id": execution["id"]},
                 run_id=None, session_id=task_id)
    conn.commit()
    handle = live_handle(execution["id"])
    if handle is not None:
        handle.steer_queue.push(text)
    else:
        # Queued with no live handle (or a handle lost to a restart racing this
        # call): fold the steer into the direction so it is never dropped.
        conn.execute(
            "UPDATE task_executions SET direction = direction || ? WHERE id = ?",
            (f"\n\n[steer] {redact_text(str(text or ''))[:2000]}", execution["id"]))
        conn.commit()
    return store.get_execution(conn, execution["id"])


def stop(conn: sqlite3.Connection, execution_id: str) -> dict[str, Any] | None:
    """Ask an execution to stop. A running one cancels through the model loop
    (partial Work Result persists, stopped=true); a queued one is cancelled
    directly. Returns the current row, or None if unknown."""
    execution = store.get_execution(conn, execution_id)
    if execution is None:
        return None
    if execution["status"] in store.EXEC_TERMINAL_STATUSES + (store.EXEC_WAITING,):
        return execution
    handle = live_handle(execution_id)
    if execution["status"] == store.EXEC_QUEUED and (handle is None or True):
        # Not started yet: cancel durably right now (the worker skips
        # non-queued rows). The live handle's cancel_event is set too, closing
        # the race where the worker claimed it between our read and update.
        store.set_execution_status(conn, execution_id, store.EXEC_CANCELLED)
        store.append_event(conn, execution_id, execution["task_id"],
                           "execution.status", {"status": store.EXEC_CANCELLED},
                           commit=False)
        store.refresh_task_status(conn, execution["task_id"])
        conn.commit()
        hub.mark_done(execution_id)
    if handle is not None:
        handle.cancel_event.set()
    audit.record(conn, "task.execution.stop",
                 {"task_id": execution["task_id"], "execution_id": execution_id},
                 run_id=None, session_id=execution["task_id"])
    conn.commit()
    return store.get_execution(conn, execution_id)


def resume(conn: sqlite3.Connection, execution_id: str) -> dict[str, Any]:
    """Resume an interrupted/failed execution as a NEW execution that carries
    the original Direction plus an explicit continuation note. The original row
    keeps its terminal state — history is never rewritten."""
    execution = store.get_execution(conn, execution_id)
    if execution is None:
        raise KeyError("execution not found")
    if execution["status"] not in (store.EXEC_INTERRUPTED, store.EXEC_FAILED,
                                   store.EXEC_CANCELLED):
        raise ValueError("only an interrupted, failed, or cancelled execution can be resumed")
    direction = (execution["direction"] or "").strip()
    note = ("\n\n[resume] The previous execution of this direction was "
            f"{execution['status']} before it could finish. Continue from what the "
            "task has already established; do not start over.")
    return submit(conn, execution["task_id"], direction + note,
                  kind="resume", resumed_from=execution_id)


def on_decision_resolved(conn: sqlite3.Connection, decision: dict[str, Any]) -> None:
    """Durable follow-through of a Decision resolution: event + settle any
    execution that was WAITING on it + task status."""
    store.append_event(conn, decision.get("execution_id") or "", decision["task_id"],
                       "decision.resolved",
                       {"decision_id": decision["id"], "resolution": decision["status"],
                        "action_type": decision["action_type"]}, commit=False)
    settle_waiting_executions(conn, decision["task_id"])
    store.refresh_task_status(conn, decision["task_id"])
    conn.commit()


def settle_waiting_executions(conn: sqlite3.Connection, task_id: str) -> None:
    """Complete every WAITING execution whose pending decisions are all gone
    (resolved or superseded). The confirmation boundary was crossed — the
    delegated work is now finished, durably."""
    rows = conn.execute(
        "SELECT id FROM task_executions WHERE task_id = ? AND status = ?",
        (task_id, store.EXEC_WAITING)).fetchall()
    for r in rows:
        pending = conn.execute(
            "SELECT 1 FROM task_decisions WHERE execution_id = ? AND status = ? LIMIT 1",
            (r["id"], store.DECISION_PENDING)).fetchone()
        if pending is None:
            store.set_execution_status(conn, r["id"], store.EXEC_COMPLETED)
            store.append_event(conn, r["id"], task_id, "execution.status",
                               {"status": store.EXEC_COMPLETED,
                                "reason": "decision_resolved"}, commit=False)
            hub.mark_done(r["id"])


# --- the per-task worker ---------------------------------------------------------


def _ensure_worker(task_id: str) -> None:
    with _lock:
        t = _workers.get(task_id)
        if t is not None and t.is_alive():
            return
        t = threading.Thread(target=_drain_task, args=(task_id,),
                             name=f"task-exec-{task_id[:8]}", daemon=True)
        _workers[task_id] = t
        t.start()


def _drain_task(task_id: str) -> None:
    """Worker main loop: run the task's queued executions IN ORDER until none
    remain. One live execution per task; other tasks run on their own workers
    concurrently (live execution is keyed per durable task)."""
    try:
        while True:
            conn = connect()
            try:
                execution = store.next_queued_execution(conn, task_id)
            finally:
                conn.close()
            if execution is None:
                return
            _run_execution(execution)
    finally:
        with _lock:
            if _workers.get(task_id) is threading.current_thread():
                del _workers[task_id]
        # A submit that raced our exit re-checks: if new queued work appeared
        # after the last scan but before deregistration, restart the worker.
        conn = connect()
        try:
            leftover = store.next_queued_execution(conn, task_id)
        except Exception:  # noqa: BLE001
            leftover = None
        finally:
            conn.close()
        if leftover is not None:
            _ensure_worker(task_id)


def _run_execution(execution: dict[str, Any]) -> None:
    """Run ONE durable execution to a terminal (or waiting) state.

    Owns its own connection and event loop for its entire lifetime — no HTTP
    request state is involved anywhere. Every transition lands in the durable
    event log before anything transient sees it."""
    import asyncio

    exec_id, task_id = execution["id"], execution["task_id"]
    with _lock:
        handle = _live.get(exec_id)
        if handle is None:
            handle = LiveExecution(exec_id, task_id)
            _live[exec_id] = handle
    hub.open_live(exec_id)

    conn = connect()
    wloop = asyncio.new_event_loop()
    try:
        # Claim atomically: only a still-queued row runs (stop() may have
        # cancelled it between the scan and now).
        cur = conn.execute(
            "UPDATE task_executions SET status = ?, started_at = ?, updated_at = ? "
            "WHERE id = ? AND status = ?",
            (store.EXEC_RUNNING, _now(), _now(), exec_id, store.EXEC_QUEUED))
        conn.commit()
        if cur.rowcount <= 0:
            return
        store.append_event(conn, exec_id, task_id, "execution.status",
                           {"status": store.EXEC_RUNNING})
        row = conn.execute("SELECT * FROM sessions WHERE id = ?", (task_id,)).fetchone()
        if row is None:
            store.set_execution_status(conn, exec_id, store.EXEC_FAILED,
                                       error="task no longer exists")
            conn.commit()
            return
        summary = sessions_repo.get_summary(conn, task_id) or \
            summary_builder.refresh(conn, task_id)
        recent = sessions_repo.list_messages(conn, task_id, limit=_CONTEXT_MESSAGES)
        attachments = sds_repo.list_pending_for_session(conn, task_id)
        creds = get_model_credentials(conn)  # raises AgentUnavailable

        # SESSION_LOOP is the documented single-turn test seam ("tests may
        # monkeypatch that seam with a fake"). When it is patched, drive the
        # legacy blocking loop so fakes keep working; the default is the same
        # streaming implementation either way — one turn implementation.
        if session_agent.SESSION_LOOP is not session_agent._streamed_session_loop:
            t0 = time.monotonic()
            contract = session_agent.answer(
                dict(row), summary, recent, execution["direction"] or "", creds,
                conn, execution["turn_id"], attachments=attachments,
                cancel_event=handle.cancel_event)
            for rec in contract.get("tool_activity") or []:
                _persist_tool_event(conn, exec_id, task_id, rec)
            _finish(conn, execution, handle, contract, creds,
                    int((time.monotonic() - t0) * 1000))
            return

        final: dict[str, Any] = {}
        emitted_tools = 0

        async def drive() -> None:
            clients: list[Any] = []
            try:
                result, activity, skill_names, finalize, _, budget = \
                    session_agent.build_stream(
                        dict(row), summary, recent, execution["direction"] or "",
                        creds, conn, execution["turn_id"], attachments=attachments,
                        cancel_event=handle.cancel_event, clients=clients,
                        steer_queue=handle.steer_queue)
            except BaseException:
                await session_agent._close_clients(clients)
                raise
            nonlocal emitted_tools
            async for kind, data in session_agent.stream_events_for(
                    result, activity, skill_names, finalize,
                    cancel_event=handle.cancel_event, clients=clients, budget=budget,
                    answer_cap=session_agent._answer_cap(creds)):
                if kind == "final":
                    final["data"] = data
                elif kind == "delta":
                    hub.push_delta(exec_id, data)
                elif kind == "tool":
                    _persist_tool_event(conn, exec_id, task_id, data)
                    emitted_tools += 1

        t0 = time.monotonic()
        try:
            wloop.run_until_complete(drive())
        except AgentUnavailable:
            raise
        except Exception as exc:  # noqa: BLE001
            _fail(conn, exec_id, task_id, _safe_err(exc))
            return
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        data = final.get("data")
        if data is None:
            _fail(conn, exec_id, task_id, "the execution produced no result")
            return
        _finish(conn, execution, handle, data, creds, elapsed_ms)
    except AgentUnavailable as exc:
        _fail(conn, exec_id, task_id, _safe_err(exc))
    except Exception as exc:  # noqa: BLE001
        _fail(conn, exec_id, task_id, _safe_err(exc))
    finally:
        handle.done_event.set()
        hub.mark_done(exec_id)
        with _lock:
            _live.pop(exec_id, None)
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass
        # Drain the loop before closing (same discipline as the old worker): an
        # early error exit can leave run_streamed's background task pending.
        try:
            import asyncio as _a
            pending = _a.all_tasks(wloop)
            for t in pending:
                t.cancel()
            if pending:
                wloop.run_until_complete(_a.gather(*pending, return_exceptions=True))
            wloop.run_until_complete(wloop.shutdown_asyncgens())
        except Exception:  # noqa: BLE001
            pass
        try:
            wloop.close()
        except Exception:  # noqa: BLE001
            pass


def _persist_tool_event(conn: sqlite3.Connection, exec_id: str, task_id: str,
                        record: dict[str, Any]) -> None:
    """One structured tool progress event, bounded. `user_steer` activity rows
    are the injection wrapper's delivery notices — persisted as steer.applied."""
    payload = {k: record.get(k) for k in ("id", "tool", "target", "result", "ok")
               if record.get(k) is not None}
    status = record.get("status")
    if record.get("tool") == "user_steer":
        store.append_event(conn, exec_id, task_id, "steer.applied",
                           {"text": str(record.get("result") or "")[:200]})
        return
    event_type = "tool.started" if status == "started" else "tool.completed"
    store.append_event(conn, exec_id, task_id, event_type, payload)


def _fail(conn: sqlite3.Connection, exec_id: str, task_id: str, error: str) -> None:
    store.set_execution_status(conn, exec_id, store.EXEC_FAILED, error=error)
    store.append_event(conn, exec_id, task_id, "execution.status",
                       {"status": store.EXEC_FAILED, "error": error[:400]}, commit=False)
    store.refresh_task_status(conn, task_id)
    conn.commit()


def _finish(conn: sqlite3.Connection, execution: dict[str, Any], handle: LiveExecution,
            data: dict[str, Any], creds: dict[str, Any], elapsed_ms: int) -> None:
    """Persist everything a finished execution produced, durably and in order:
    Direction (+ delivered steers) → Work Result → Decisions → context version
    → execution status. Then carry any undelivered steer into a follow-up."""
    exec_id, task_id = execution["id"], execution["task_id"]
    stopped = bool(data.get("stopped"))
    proposals = data.get("next_action_proposals") or []
    grounding = {
        "evidence_used": data.get("evidence_used", []),
        "evidence_gaps": data.get("evidence_gaps", []),
        "skills_used": data.get("skills_used", []),
    }
    cut_short = data.get("budget_stopped_on") or None

    sessions_repo.add_message(conn, task_id, "user", execution["direction"] or "")
    for steer_text in handle.steer_queue.delivered:
        sessions_repo.add_message(conn, task_id, "user", f"[steer] {steer_text}")
    mid = sessions_repo.add_message(conn, task_id, "assistant", data["answer"],
                                    tool_activity=data.get("tool_activity"),
                                    grounding=grounding, proposed_actions=proposals)
    wr_id = store.record_work_result(conn, task_id, exec_id, mid, stopped=stopped,
                                     cut_short=cut_short, grounding=grounding,
                                     proposals=proposals)
    store.append_event(conn, exec_id, task_id, "work_result.recorded",
                       {"work_result_id": wr_id, "message_id": mid, "stopped": stopped,
                        **({"cut_short": cut_short} if cut_short else {})}, commit=False)
    decisions = store.open_decisions_from_proposals(conn, task_id, exec_id, wr_id, proposals)
    for d in decisions:
        store.append_event(conn, exec_id, task_id, "decision.opened",
                           {"decision_id": d["id"], "action_type": d["action_type"],
                            "title": d["title"]}, commit=False)
    # A newer Work Result superseded older pending decisions — any execution
    # still waiting on those is now settled.
    settle_waiting_executions(conn, task_id)
    audit.record(conn, "session.message", {"session_id": task_id, "stopped": stopped},
                 run_id=None, session_id=task_id)
    session_activity.record_turn(
        conn, task_id, turn_id=execution["turn_id"], message_id=mid,
        model=(creds or {}).get("model"), duration_ms=elapsed_ms,
        tool_calls=len(data.get("tool_activity") or []),
        usage=data.get("usage"), budget_tokens=data.get("budget_tokens"),
        repeat_calls_avoided=data.get("repeat_calls_avoided"))
    try:
        version = task_context.refresh(conn, task_id, exec_id)
        if version is not None:
            store.append_event(conn, exec_id, task_id, "context.updated",
                               {"version": version}, commit=False)
    except Exception:  # noqa: BLE001 — context bookkeeping must never fail a turn
        pass
    if decisions and not stopped:
        final_status = store.EXEC_WAITING
    elif stopped:
        final_status = store.EXEC_CANCELLED
    else:
        final_status = store.EXEC_COMPLETED
    store.set_execution_status(conn, exec_id, final_status, work_result_id=wr_id)
    metrics = {"duration_ms": elapsed_ms,
               "tool_calls": len(data.get("tool_activity") or []),
               "model": (creds or {}).get("model")}
    if data.get("usage"):
        metrics["usage"] = data["usage"]
    for k in ("budget_tokens", "budget_stopped_on", "repeat_calls_avoided"):
        if data.get(k) is not None:
            metrics[k] = data[k]
    store.append_event(conn, exec_id, task_id, "execution.status",
                       {"status": final_status, "stopped": stopped,
                        "message_id": mid, "work_result_id": wr_id,
                        "proposed_actions": _bounded_proposals(proposals),
                        "metrics": metrics}, commit=False)
    store.refresh_task_status(conn, task_id)
    conn.commit()
    # A steer that arrived while the model was already writing its answer was
    # never injectable — carry it forward as its own execution so the user's
    # direction is acted on, not dropped.
    undelivered = handle.steer_queue.undelivered()
    if undelivered and not stopped:
        try:
            submit(conn, task_id, "\n".join(undelivered), kind="steer_followup",
                   require_model=False)
        except Exception:  # noqa: BLE001 — best-effort; the steer is in the event log
            pass


def _bounded_proposals(proposals: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Proposal summaries small enough for one event payload."""
    out = []
    for p in (proposals or [])[:10]:
        if isinstance(p, dict):
            out.append({"id": p.get("id"), "action_type": p.get("action_type"),
                        "title": str(p.get("title") or "")[:120],
                        "requires_confirmation": bool(p.get("requires_confirmation"))})
    return out


def wait_for_completion(execution_id: str, timeout_s: float = 150.0) -> bool:
    """Block until the execution's worker finishes (compat for the blocking
    endpoint). True when it finished within the timeout. Falls back to polling
    the durable row when no live handle exists (worker in another lifetime)."""
    handle = live_handle(execution_id)
    if handle is not None:
        return handle.done_event.wait(timeout_s)
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        conn = connect()
        try:
            row = store.get_execution(conn, execution_id)
        finally:
            conn.close()
        if row is None:
            return True
        if row["status"] not in store.EXEC_ACTIVE_STATUSES:
            return True
        time.sleep(0.25)
    return False


def _now() -> str:
    from ..repositories import utcnow
    return utcnow()


def _reset_for_tests() -> None:
    with _lock:
        _live.clear()
        _workers.clear()


__all__ = ["submit", "steer", "stop", "resume", "on_decision_resolved",
           "settle_waiting_executions", "wait_for_completion", "live_handle",
           "LiveExecution"]
