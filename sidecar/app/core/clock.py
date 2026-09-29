"""Small shared helpers: the one timestamp format, and "was a secret given"."""

from __future__ import annotations

from datetime import datetime, timezone


def utcnow() -> str:
    """Current UTC timestamp as an ISO-8601 'Z' string."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def has_value(v: str | None) -> bool:
    """True if a secret string was meaningfully provided."""
    return v is not None and v.strip() != ""
