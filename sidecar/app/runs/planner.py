"""Deterministic (rule-based) planner for diagnostic runs.

No LLM is involved. The plan is a fixed, auditable sequence of read-only steps.
"""

from __future__ import annotations


def diagnostic_plan(bucket: str, prefix: str | None) -> list[str]:
    scope = prefix or "(bucket root)"
    return [
        "Validate provider credentials with a read-only call (test_credentials).",
        f"Check accessibility of bucket '{bucket}' (head_bucket).",
        f"Sample objects under prefix {scope} with a bounded max_keys "
        "(list_objects_v2 — not a full bucket scan).",
        "Summarize evidence into findings.",
        "Generate a local Markdown diagnostic report.",
    ]
