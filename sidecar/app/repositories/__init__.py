"""Data-access layer: SQLite rows in, response models out.

Repositories own the only paths that touch secrets: plaintext arrives in a
create/update call, is written to the keyring, and only the ``keyring://``
reference is persisted in SQLite.
"""

from __future__ import annotations

from datetime import datetime, timezone


def utcnow() -> str:
    """Current UTC timestamp as an ISO-8601 'Z' string."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def has_value(v: str | None) -> bool:
    """True if a secret string was meaningfully provided."""
    return v is not None and v.strip() != ""
