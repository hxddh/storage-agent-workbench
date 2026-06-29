"""Global app settings (key/value). Never stores secrets.

Currently holds the agent autonomy policy. Values are small strings; secrets
live only in the encrypted local vault (see ``security.keyring_store``).
"""

from __future__ import annotations

import sqlite3

from ..agent_runtime import autonomy

_AUTONOMY_KEY = "autonomy_policy"


def get(conn: sqlite3.Connection, key: str, default: str | None = None) -> str | None:
    row = conn.execute("SELECT value FROM app_settings WHERE key = ?", (key,)).fetchone()
    return row[0] if row is not None else default


def set(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
        (key, value),
    )


def get_autonomy_policy(conn: sqlite3.Connection) -> str:
    """The current autonomy policy, normalized (default ``autonomous_readonly``)."""
    return autonomy.normalize(get(conn, _AUTONOMY_KEY, autonomy.DEFAULT_POLICY))


def set_autonomy_policy(conn: sqlite3.Connection, policy: str) -> str:
    """Persist a normalized autonomy policy. Returns the stored value."""
    normalized = autonomy.normalize(policy)
    set(conn, _AUTONOMY_KEY, normalized)
    return normalized


__all__ = ["get", "set", "get_autonomy_policy", "set_autonomy_policy"]
