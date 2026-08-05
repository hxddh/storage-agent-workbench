"""Read side of session observability.

Every row these queries return was written sanitized (``redact`` on the way in),
so nothing here re-derives or re-exposes anything the audit trail did not
already hold. What is new is the ability to ASK for it: before the session_id
columns existed, a conversational turn's tool calls and audit events were
recorded with no link to the session they belonged to, so rule 17's trail could
be written but never read back.

Everything is bounded and reports its own truncation — a partial timeline that
looks complete would be worse than no timeline at all.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from typing import Any

from . import utcnow

# Hard ceiling per request regardless of what the caller asks for. A long
# investigation can accumulate thousands of calls; the inspector pages.
MAX_LIMIT = 500
DEFAULT_LIMIT = 200


def _bounded(limit: int | None) -> int:
    if not limit or limit <= 0:
        return DEFAULT_LIMIT
    return min(int(limit), MAX_LIMIT)


def _loads(raw: Any) -> Any:
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return None


def list_activity(
    conn: sqlite3.Connection, session_id: str, limit: int | None = None, offset: int = 0
) -> dict[str, Any]:
    """The session's tool calls, oldest first, with sanitized input/output and
    the measured duration.

    Oldest-first because this is a TIMELINE: the waterfall reads top-to-bottom in
    execution order. Paging therefore walks forward through the investigation.
    """
    lim = _bounded(limit)
    off = max(0, int(offset or 0))
    total = conn.execute(
        "SELECT count(*) FROM tool_calls WHERE session_id = ?", (session_id,)
    ).fetchone()[0]
    rows = conn.execute(
        "SELECT id, tool_name, input_json_sanitized, output_json_sanitized, status, "
        "       duration_ms, created_at "
        "FROM tool_calls WHERE session_id = ? "
        "ORDER BY created_at ASC, rowid ASC LIMIT ? OFFSET ?",
        (session_id, lim, off),
    ).fetchall()
    items = [
        {
            "id": r["id"],
            "tool_name": r["tool_name"],
            "input": _loads(r["input_json_sanitized"]),
            "output": _loads(r["output_json_sanitized"]),
            "status": r["status"],
            "duration_ms": r["duration_ms"],
            "created_at": r["created_at"],
        }
        for r in rows
    ]
    return {
        "items": items,
        "total": int(total),
        "offset": off,
        "limit": lim,
        # Never a silent cap: the caller (and the UI) can always tell that more
        # exists beyond what was returned.
        "truncated": off + len(items) < int(total),
    }


def list_audit(
    conn: sqlite3.Connection, session_id: str, limit: int | None = None, offset: int = 0
) -> dict[str, Any]:
    """The session's audit trail (rule 17), oldest first."""
    lim = _bounded(limit)
    off = max(0, int(offset or 0))
    total = conn.execute(
        "SELECT count(*) FROM audit_logs WHERE session_id = ?", (session_id,)
    ).fetchone()[0]
    rows = conn.execute(
        "SELECT id, event_type, payload_json_sanitized, run_id, created_at "
        "FROM audit_logs WHERE session_id = ? "
        "ORDER BY created_at ASC, rowid ASC LIMIT ? OFFSET ?",
        (session_id, lim, off),
    ).fetchall()
    items = [
        {
            "id": r["id"],
            "event_type": r["event_type"],
            "payload": _loads(r["payload_json_sanitized"]),
            "run_id": r["run_id"],
            "created_at": r["created_at"],
        }
        for r in rows
    ]
    return {
        "items": items,
        "total": int(total),
        "offset": off,
        "limit": lim,
        "truncated": off + len(items) < int(total),
    }


def record_turn(
    conn: sqlite3.Connection,
    session_id: str,
    *,
    turn_id: str | None,
    message_id: str | None,
    model: str | None,
    duration_ms: int | None,
    tool_calls: int | None,
    usage: dict[str, Any] | None,
) -> None:
    """Record what one turn cost. Token columns stay NULL when the provider did
    not report usage — a measured zero and "not reported" must not collapse."""
    u = usage or {}

    def _n(key: str) -> int | None:
        if not usage:
            return None
        try:
            return int(u.get(key) or 0)
        except (TypeError, ValueError):
            return None

    def _opt(key: str) -> int | None:
        """An OPTIONAL metric: NULL when the endpoint did not report it.

        `_n` coalesces a missing key to 0, which is right for the core token
        counts (present whenever usage is) and wrong for the detail columns —
        writing 0 there would state "nothing was cached" when the truth is
        "this endpoint does not say". A genuine 0 still stores as 0."""
        if not usage or u.get(key) is None:
            return None
        try:
            return int(u[key])
        except (TypeError, ValueError):
            return None

    conn.execute(
        "INSERT INTO turn_metrics (id, session_id, turn_id, message_id, model, requests, "
        " input_tokens, output_tokens, total_tokens, cached_input_tokens, reasoning_tokens, "
        " duration_ms, tool_calls, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (uuid.uuid4().hex, session_id, turn_id, message_id, model, _n("requests"),
         _n("input_tokens"), _n("output_tokens"), _n("total_tokens"),
         # NULL, not 0, when the endpoint omitted the detail: "not reported" and
         # "nothing cached" are different facts (v0.53.0).
         _opt("cached_input_tokens"), _opt("reasoning_tokens"),
         duration_ms, tool_calls, utcnow()),
    )


def usage_rollup(conn: sqlite3.Connection, session_id: str) -> dict[str, Any]:
    """Token usage for the session, plus whether it is even knowable.

    ``available`` is the honest bit: an endpoint that doesn't report usage
    produces rows with NULL token columns, and that must render as
    "unavailable", never as a confident zero.
    """
    row = conn.execute(
        "SELECT count(*) n, "
        "       COALESCE(sum(CASE WHEN total_tokens IS NOT NULL THEN 1 ELSE 0 END), 0) measured, "
        "       COALESCE(sum(input_tokens), 0) i, "
        "       COALESCE(sum(output_tokens), 0) o, COALESCE(sum(total_tokens), 0) t, "
        "       COALESCE(sum(requests), 0) r, COALESCE(sum(duration_ms), 0) ms, "
        "       COALESCE(sum(CASE WHEN cached_input_tokens IS NOT NULL THEN 1 ELSE 0 END), 0) cm, "
        "       COALESCE(sum(cached_input_tokens), 0) c, "
        "       COALESCE(sum(CASE WHEN reasoning_tokens IS NOT NULL THEN 1 ELSE 0 END), 0) rm, "
        "       COALESCE(sum(reasoning_tokens), 0) rt "
        "FROM turn_metrics WHERE session_id = ?",
        (session_id,),
    ).fetchone()
    measured = int(row["measured"] or 0)
    turns = int(row["n"] or 0)
    return {
        "available": measured > 0,
        "turns": turns,
        # When only SOME turns reported usage the totals are a floor, not a
        # total. Say so rather than presenting a partial sum as complete.
        "turns_measured": measured,
        "partial": 0 < measured < turns,
        "input_tokens": int(row["i"] or 0),
        "output_tokens": int(row["o"] or 0),
        "total_tokens": int(row["t"] or 0),
        "requests": int(row["r"] or 0),
        "duration_ms": int(row["ms"] or 0),
        # Cached input is typically an order of magnitude cheaper, and the fixed
        # prefix (instructions + tool schemas + context) is re-sent on every step
        # of a multi-step turn — so the hit rate, not the raw input count, is
        # what a turn actually costs. None when no turn reported it.
        "cached_input_tokens": int(row["c"] or 0) if int(row["cm"] or 0) else None,
        # Output the user pays for and never sees.
        "reasoning_tokens": int(row["rt"] or 0) if int(row["rm"] or 0) else None,
    }


def list_turns(conn: sqlite3.Connection, session_id: str,
               limit: int | None = None) -> list[dict[str, Any]]:
    """Per-turn metrics, oldest first."""
    rows = conn.execute(
        "SELECT turn_id, message_id, model, requests, input_tokens, output_tokens, "
        "       total_tokens, cached_input_tokens, reasoning_tokens, "
        "       duration_ms, tool_calls, created_at "
        "FROM turn_metrics WHERE session_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ?",
        (session_id, _bounded(limit)),
    ).fetchall()
    return [dict(r) for r in rows]


def overview(conn: sqlite3.Connection, session_id: str) -> dict[str, Any]:
    """The inspector's header band: what happened in this session, in counts.

    Deliberately a few cheap aggregates rather than a full scan — this renders
    on every inspector open, including on a session with thousands of calls.
    """
    calls = conn.execute(
        "SELECT count(*) n, COALESCE(sum(duration_ms), 0) ms, "
        "       COALESCE(sum(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) errs "
        "FROM tool_calls WHERE session_id = ?",
        (session_id,),
    ).fetchone()
    approvals = conn.execute(
        "SELECT count(*) FROM audit_logs WHERE session_id = ? AND event_type LIKE '%approv%'",
        (session_id,),
    ).fetchone()[0]
    events = conn.execute(
        "SELECT count(*) FROM audit_logs WHERE session_id = ?", (session_id,)
    ).fetchone()[0]
    return {
        "tool_calls": int(calls["n"] or 0),
        "tool_errors": int(calls["errs"] or 0),
        "tool_ms": int(calls["ms"] or 0),
        "audit_events": int(events),
        "approvals": int(approvals),
        "usage": usage_rollup(conn, session_id),
        "turns": list_turns(conn, session_id),
    }
