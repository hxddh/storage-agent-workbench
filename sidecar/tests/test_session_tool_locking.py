"""Regression: session tools must not hold an open write transaction.

The audit row a session tool records is the only write on the request
connection during a turn. If it stays uncommitted, the connection holds the
SQLite/WAL write lock across the next slow S3 call and can starve a
concurrently-running inline run's writes ("database is locked"). Each tool must
commit its audit row immediately, leaving no open write transaction.
"""

from app import db
from app.agent_runtime import session_tools


class _FT:
    def __call__(self, fn):
        fn.name = fn.__name__
        return fn


def test_session_tool_leaves_no_open_write_txn(client):
    conn = db.connect()
    try:
        tools = {t.name: t for t in session_tools.build(conn, _FT(), [])}
        tools["list_providers"]()  # records + should commit its audit row

        # No write transaction is held open after the tool returns.
        assert conn.in_transaction is False

        # The audit row was actually persisted (visible to a separate connection,
        # which also confirms the lock was released — this would block/timeout if
        # the first connection still held an uncommitted write).
        other = db.connect()
        try:
            n = other.execute(
                "SELECT count(*) FROM audit_logs WHERE event_type = 'session_tool'"
            ).fetchone()[0]
        finally:
            other.close()
        assert n >= 1
    finally:
        conn.close()
