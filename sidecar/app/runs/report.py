"""Local Markdown report generation for diagnostic runs.

The report is built from already-sanitized tool outputs and, as defense in
depth, the entire rendered document is passed through the redaction utility
before being written. It must never contain credentials, tokens, signatures,
or presigned-URL parameters.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .. import config
from ..security.redaction import redact_text

_TOOL_ORDER = ["test_credentials", "head_bucket", "list_objects_v2"]


def report_path_for(run_id: str) -> Path:
    return config.data_dir() / "runs" / run_id / "report.md"


def _evidence_block(name: str, output: dict[str, Any] | None) -> str:
    body = json.dumps(output or {"note": "not run"}, indent=2, default=str)
    return f"### {name}\n\n```json\n{body}\n```\n"


def render(
    run: dict[str, Any],
    evidence: dict[str, dict[str, Any]],
    findings: list[dict[str, str]],
    summary: str,
) -> str:
    # No canned "Plan" section: the report publishes the REAL tool trace
    # (evidence blocks) — a fixed step list would misrepresent the run.
    evidence_md = "\n".join(_evidence_block(n, evidence.get(n)) for n in _TOOL_ORDER)
    if findings:
        findings_md = "\n".join(
            f"- **[{f['severity']}]** {f['title']} — {f['detail']}" for f in findings
        )
    else:
        findings_md = "- No findings."

    content = f"""# Diagnostic Report

## Summary

{summary}

## Scope

- Provider: {run.get('provider_id') or '—'}
- Bucket: {run.get('bucket') or '—'}
- Prefix: {run.get('prefix') or '(bucket root)'}
- Run ID: {run.get('id')}
- Created at: {run.get('created_at')}

## Evidence

{evidence_md}

## Findings

{findings_md}

## Limitations

- `list_objects_v2` is bounded (a small `max_keys`, at most 20 sample keys) and
  is **not** a full bucket scan; more objects may exist.
- No object bodies were downloaded.
- This is a deterministic, rule-based diagnostic — no LLM reasoning was used.

## Safety

- Cloud credentials are read from the system Keychain at call time and are
  never included in this report, logs, or events.
- Only read-only operations were performed; no destructive or mutating S3
  operations are possible in this build.
"""
    # Defense in depth: scrub the whole document.
    return redact_text(content)


def write_report(
    run: dict[str, Any],
    evidence: dict[str, dict[str, Any]],
    findings: list[dict[str, str]],
    summary: str,
) -> tuple[str, str]:
    """Render and write the report; return (path, content)."""
    content = render(run, evidence, findings, summary)
    path = report_path_for(run["id"])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return str(path), content
