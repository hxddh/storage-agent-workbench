"""Agent-task projection for the desktop product shell.

Sessions remain the durable storage/API contract. This endpoint projects those
records into the product-level Agent Task command center and adds state that must
survive reloads, most importantly a pending confirmation decision from the latest
Agent Work Result.

Decision state is derived from the latest assistant message only. Historical
confirmation proposals are audit history, not current blockers; a later Work
Result supersedes them. The lookup is batched for the whole task list so the
command center does not introduce an N+1 detail-fetch pattern.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from ..db import get_conn
from ..models.schemas import SessionSummary
from ..repositories import sessions as sessions_repo

router = APIRouter(prefix="/agent-tasks", tags=["agent-tasks"])


class AgentTaskSummary(SessionSummary):
    """Durable Session summary projected into product-level Agent task state."""

    requires_decision: bool = False


def _requires_decision(raw: Any) -> bool:
    if not raw:
        return False
    try:
        actions = json.loads(raw) if isinstance(raw, str) else raw
    except (TypeError, ValueError):
        return False
    if not isinstance(actions, list):
        return False
    return any(
        isinstance(action, dict) and action.get("requires_confirmation") is True
        for action in actions
    )


def _latest_decisions(
    conn: sqlite3.Connection, task_ids: list[str]
) -> dict[str, bool]:
    """Return current durable Decision state for all requested tasks in one query."""
    if not task_ids:
        return {}
    placeholders = ",".join("?" * len(task_ids))
    rows = conn.execute(
        "SELECT m.session_id, m.proposed_actions "
        "FROM session_messages m "
        "JOIN ("
        "  SELECT session_id, MAX(rowid) AS latest_rowid "
        "  FROM session_messages "
        "  WHERE role = 'assistant' AND session_id IN (" + placeholders + ") "
        "  GROUP BY session_id"
        ") latest ON latest.latest_rowid = m.rowid",
        task_ids,
    ).fetchall()
    return {row["session_id"]: _requires_decision(row["proposed_actions"]) for row in rows}


@router.get("", response_model=list[AgentTaskSummary])
def list_agent_tasks(q: str | None = None, conn: sqlite3.Connection = Depends(get_conn)):
    rows = sessions_repo.search(conn, q) if q else sessions_repo.list_all(conn)
    decisions = _latest_decisions(conn, [row["id"] for row in rows])
    return [AgentTaskSummary(**{**row, "requires_decision": decisions.get(row["id"], False)}) for row in rows]
