"""Audit logging.

Every provider mutation (and, in later phases, tool calls / approvals / report
generation) is recorded in ``audit_logs``. Payloads are redacted before
insertion so secrets never reach the audit trail.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from typing import Any

from .security.redaction import redact


def record(
    conn: sqlite3.Connection,
    event_type: str,
    payload: dict[str, Any] | None = None,
    run_id: str | None = None,
) -> None:
    """Insert a redacted audit-log entry. Does not commit."""
    safe = redact(payload or {})
    conn.execute(
        "INSERT INTO audit_logs (id, run_id, event_type, payload_json_sanitized, created_at) "
        "VALUES (?, ?, ?, ?, datetime('now'))",
        (uuid.uuid4().hex, run_id, event_type, json.dumps(safe)),
    )
