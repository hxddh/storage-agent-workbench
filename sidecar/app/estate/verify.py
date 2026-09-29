"""Read-only re-check of an issue (v4.0).

Verify re-reads the bucket's configuration with the same read-only review the
issue's rule belongs to (``review_bucket_security`` or
``review_bucket_lifecycle`` — get_/list_ calls only), records the call like
every other tool call, and applies the verdict through the one lifecycle in
``store.observe``. It never writes to storage. A review that could not read
what the rule needs decides nothing: the result is ``inconclusive`` and the
issue keeps its state.
"""

from __future__ import annotations

import sqlite3
from typing import Any

from ..repositories import cloud_providers as cloud_repo
from ..repositories import utcnow
from ..s3 import config_tools as ct
from ..s3.scope import check_scope
from ..tool_runner import run_tool
from . import rules, store

_CHECKS = {
    "security": ("review_bucket_security", ct.review_bucket_security),
    "lifecycle": ("review_bucket_lifecycle", ct.review_bucket_lifecycle),
}


class VerifyError(Exception):
    """The issue cannot be re-checked (unknown, out of scope, provider gone)."""


def recheck_bucket(conn: sqlite3.Connection, provider_id: str, bucket: str, checks: set[str], *,
                   source: str, session_id: str | None = None) -> tuple[dict[str, rules.Verdict], list[dict[str, Any]]]:
    """Run the named read-only reviews on one bucket and apply their verdicts.
    Returns (verdicts, issue changes)."""
    provider = cloud_repo.get(conn, provider_id)
    if provider is None:
        raise VerifyError("The cloud provider for this issue no longer exists.")
    denial = check_scope(provider.allowed_buckets, provider.allowed_prefixes, bucket)
    if denial:
        raise VerifyError(denial)
    verdicts: dict[str, rules.Verdict] = {}
    details: dict[str, str] = {}
    for check in sorted(checks):
        name, fn = _CHECKS[check]
        out = run_tool(conn, name, {"provider_id": provider_id, "bucket": bucket},
                       lambda fn=fn: fn(conn, provider_id, bucket), session_id=session_id)
        v, d = rules.evaluate_review(check, out)
        verdicts.update(v)
        details.update(d)
    store.upsert_bucket(conn, provider_id, bucket)
    changes = store.observe(conn, provider_id, bucket, verdicts, details, source=source)
    conn.commit()
    return verdicts, changes


def verify_issue(conn: sqlite3.Connection, issue_id: str, *, source: str = "verify") -> dict[str, Any]:
    row = conn.execute("SELECT * FROM issues WHERE id = ?", (issue_id,)).fetchone()
    if row is None:
        raise VerifyError("Unknown issue.")
    rule = rules.BY_CODE.get(row["code"])
    if rule is None:
        raise VerifyError("This issue has no read-only check.")
    task_id = row["source_task_id"]
    if task_id and conn.execute("SELECT 1 FROM sessions WHERE id = ?", (task_id,)).fetchone() is None:
        task_id = None
    verdicts, _changes = recheck_bucket(conn, row["provider_id"], row["bucket"], {rule.check},
                                        source=source, session_id=task_id)
    verdict = verdicts.get(row["code"])
    result = "still_present" if verdict else ("resolved" if verdict is False else "inconclusive")
    now = utcnow()
    conn.execute("UPDATE issues SET last_verified_at = ?, last_verify_result = ?, updated_at = ? "
                 "WHERE id = ?", (now, result, now, issue_id))
    store._event(conn, issue_id, "verified", source=source, detail={"result": result})
    conn.commit()
    return {"result": result, "issue": store.get_issue(conn, issue_id)}
