"""Run launch orchestration (Phase 04).

A diagnostic run executes in a background thread with its own SQLite connection,
publishing events to the in-memory bus. This is intentionally lightweight — no
Redis/Celery/external queue. Tests monkeypatch ``start`` to run synchronously.
"""

from __future__ import annotations

import threading

from . import db
from .runs.diagnostic import execute_diagnostic_run


def run_sync(run_id: str) -> None:
    """Execute a diagnostic run to completion using a fresh connection."""
    conn = db.connect()
    try:
        execute_diagnostic_run(conn, run_id)
    finally:
        conn.close()


def start(run_id: str) -> None:
    """Launch a diagnostic run in a background daemon thread."""
    threading.Thread(target=run_sync, args=(run_id,), daemon=True).start()
