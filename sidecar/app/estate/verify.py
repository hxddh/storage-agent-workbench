"""Read-only re-check of an issue (v5).

Re-runs the rule's read-only review (``review_bucket_security`` or
``review_bucket_lifecycle``), scope-checked and audited, and applies the verdict
through the one lifecycle (``store.observe``). A review that could not read
what the rule needs is ``inconclusive``; the issue keeps its state.
"""

from __future__ import annotations

import sqlite3
import time
from typing import Any

from ..core import store as core_store
from ..providers import clouds
from ..repositories import utcnow
from ..s3 import config_tools as ct
from ..s3.scope import check_scope
from ..security.redaction import redact, redact_text
from . import rules, store

CHECKS = {"security": ct.review_bucket_security, "lifecycle": ct.review_bucket_lifecycle}


class VerifyError(Exception):
    """The issue cannot be re-checked (unknown, out of scope, provider gone)."""


def recheck_bucket(conn: sqlite3.Connection, provider_id: str, bucket: str, checks: set[str], *,
                   source: str, actor: str = "user") -> tuple[dict[str, rules.Verdict], list[dict[str, Any]]]:
    cloud = clouds.get(conn, provider_id)
    if cloud is None:
        raise VerifyError("The storage account for this issue no longer exists.")
    denial = check_scope(cloud.allowed_buckets, cloud.allowed_prefixes, bucket)
    if denial:
        raise VerifyError(denial)
    outputs: dict[str, Any] = {}
    for check in sorted(checks):
        started = time.monotonic()
        try:
            out = CHECKS[check](conn, provider_id, bucket)
        except Exception as exc:  # noqa: BLE001 — a failed read decides nothing
            out = {"success": False, "error_code": type(exc).__name__,
                   "error_message_sanitized": redact_text(str(exc))[:300]}
        outputs[check] = redact(out)
        core_store.audit(conn, actor=actor, action=f"tool.review_bucket_{check}", target=bucket,
                         ok=out.get("success", True) is not False,
                         duration_ms=int((time.monotonic() - started) * 1000), detail={"source": source})
    verdicts: dict[str, rules.Verdict] = {}
    for check, out in outputs.items():
        verdicts.update(rules.evaluate_review(check, out)[0])
    changes = store.ingest_review(conn, provider_id, bucket, outputs, source=source)
    return verdicts, changes


def verify_issue(conn: sqlite3.Connection, issue_id: str, *, source: str = "verify") -> dict[str, Any]:
    row = conn.execute("SELECT * FROM issues WHERE id = ?", (issue_id,)).fetchone()
    if row is None:
        raise VerifyError("Unknown issue.")
    rule = rules.BY_CODE.get(row["code"])
    if rule is None:
        raise VerifyError("This issue has no read-only check.")
    verdicts, _changes = recheck_bucket(conn, row["provider_id"], row["bucket"], {rule.check}, source=source)
    verdict = verdicts.get(row["code"])
    result = "still_present" if verdict else ("resolved" if verdict is False else "inconclusive")
    now = utcnow()
    conn.execute("UPDATE issues SET last_verified_at = ?, last_verify_result = ?, updated_at = ? WHERE id = ?",
                 (now, result, now, issue_id))
    store.event(conn, issue_id, "verified", source=source, detail={"result": result})
    conn.commit()
    return {"result": result, "issue": store.get_issue(conn, issue_id)}
