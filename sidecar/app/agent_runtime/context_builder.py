"""Builds the sanitized context handed to the LLM (Phase 07).

Includes only safe, display-level metadata. Never includes AK/SK, session
tokens, model API keys, Authorization headers, signatures, credentials, cookies,
presigned-URL params, raw bucket policy, raw ACL grants, full key lists beyond
20 samples, or full uploaded file content / DuckDB dumps.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from ..security.redaction import redact_text
from . import guardrails
from .prompts import SAFETY_RULES


def _provider_display(conn: sqlite3.Connection, provider_id: str | None) -> dict[str, Any]:
    if not provider_id:
        return {}
    row = conn.execute(
        "SELECT name, provider_type, endpoint_url, region FROM cloud_providers WHERE id = ?",
        (provider_id,),
    ).fetchone()
    if row is None:
        return {}
    # Only safe display fields — never the *_ref columns or any secret.
    return {
        "name": row["name"],
        "provider_type": row["provider_type"],
        "endpoint_url": row["endpoint_url"],
        "region": row["region"],
    }


def build_context(
    conn: sqlite3.Connection,
    run: dict[str, Any],
    prior_findings: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    context = {
        "run_type": run.get("run_type"),
        "user_prompt": redact_text(run.get("user_prompt") or ""),
        "provider": _provider_display(conn, run.get("provider_id")),
        "bucket": run.get("bucket"),
        "prefix": run.get("prefix"),
        "prior_findings": (prior_findings or [])[: guardrails.SAMPLE_LIMIT],
        "safety_rules": SAFETY_RULES,
    }
    # Hard stop: never proceed if anything secret-shaped slipped in.
    guardrails.assert_no_secrets_in_context(context)
    return context


def render_context_text(context: dict[str, Any]) -> str:
    """Render the context as a compact text block for the LLM user turn."""
    return json.dumps(context, indent=2, default=str)
