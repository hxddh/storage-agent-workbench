"""Approval policy (v1.12) — how gated tools get their answer.

Codex-style: the user chooses, once, how much the Agent may do without
asking. Three policies, enforced in exactly ONE place
(``runtime.request_approval``), so no tool can grow its own bypass:

- ``ask`` (default) — every gated call raises a Decision and the execution
  waits for Allow / Allow for this task / Deny (today's behaviour).
- ``allow_session`` — gated calls are auto-approved for the lifetime of THIS
  Sidecar process; a restart falls back to ``ask``. Held in memory only.
- ``allow_always`` — gated calls are auto-approved for this data directory;
  stored in ``app_settings`` (ordinary configuration, never a secret).

Every auto-approval is still a durable, already-approved Decision row and an
``approval.granted`` event carrying ``policy`` — the transcript and the audit
trail show what was allowed and why. The security floor is untouched: a policy
can only answer a gate that exists; it cannot create a tool, widen a scope, or
make a read-only tool write.
"""

from __future__ import annotations

import sqlite3
import threading
from typing import Any

from ..repositories import settings as settings_repo

POLICY_ASK = "ask"
POLICY_SESSION = "allow_session"
POLICY_ALWAYS = "allow_always"
POLICIES = (POLICY_ASK, POLICY_SESSION, POLICY_ALWAYS)

SETTING_KEY = "approval_policy"

# The gates a policy can answer — the ONLY confirmation boundaries in the
# product. Kept here (not derived from the tool registry) so the Safety pane
# and the docs describe the same list the runtime enforces.
GATED_TOOLS: list[dict[str, Any]] = [
    {"name": "import_evidence",
     "action_types": ["import_inventory", "import_access_log"],
     "why": "Moves object bytes (an S3 Inventory or server access logs) from a bucket "
            "onto this machine for deterministic analysis."},
    {"name": "survey_account",
     "action_types": ["survey_account_large"],
     "why": "A survey above the default 100-bucket cap makes live read-only S3 calls "
            "across every extra bucket."},
]

_lock = threading.Lock()
_session_policy: str | None = None  # process-lifetime "allow for this session"


def get(conn: sqlite3.Connection) -> str:
    """The policy in force right now: the in-process session grant wins, then
    the durable setting, then ``ask``."""
    with _lock:
        if _session_policy == POLICY_SESSION:
            return POLICY_SESSION
    durable = settings_repo.get(conn, SETTING_KEY, POLICY_ASK)
    return POLICY_ALWAYS if durable == POLICY_ALWAYS else POLICY_ASK


def set(conn: sqlite3.Connection, policy: str) -> str:  # noqa: A001 — mirrors settings_repo
    """Apply a policy. ``allow_session`` lives in memory only (and clears a
    durable ``allow_always``); ``allow_always`` persists; ``ask`` clears both."""
    global _session_policy
    if policy not in POLICIES:
        raise ValueError(f"unknown approval policy: {policy!r}")
    with _lock:
        _session_policy = POLICY_SESSION if policy == POLICY_SESSION else None
    settings_repo.set(conn, SETTING_KEY,
                      POLICY_ALWAYS if policy == POLICY_ALWAYS else POLICY_ASK)
    return policy


def reset_session() -> None:
    """Drop the in-process grant (process restart semantics; used by tests)."""
    global _session_policy
    with _lock:
        _session_policy = None


def auto_grant_scope(conn: sqlite3.Connection) -> str | None:
    """The grant scope a policy confers on a gated call right now, or None when
    the user must be asked (``ask``)."""
    policy = get(conn)
    if policy == POLICY_ALWAYS:
        return "always"
    if policy == POLICY_SESSION:
        return "session"
    return None


def describe(conn: sqlite3.Connection) -> dict[str, Any]:
    return {"policy": get(conn), "gated_tools": [dict(t) for t in GATED_TOOLS]}


__all__ = ["POLICIES", "POLICY_ASK", "POLICY_SESSION", "POLICY_ALWAYS", "SETTING_KEY",
           "GATED_TOOLS", "get", "set", "reset_session", "auto_grant_scope", "describe"]
