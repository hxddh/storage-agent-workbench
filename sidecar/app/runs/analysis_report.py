"""Markdown report generation for analysis runs (Phase 05).

Reports are rendered from already-sanitized metrics and, as defense in depth,
the whole document is redacted before writing. Client IPs are masked upstream;
at most 20 sample keys are shown.
"""

from __future__ import annotations

from typing import Any

from ..security.redaction import redact_text
from .report import report_path_for

SAMPLE_LIMIT = 20


def _bytes_h(n: int | float | None) -> str:
    if not n:
        return "0 B"
    n = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB", "PB"):
        if n < 1024 or unit == "PB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{int(n)} B"
        n /= 1024
    return f"{n:.1f} PB"


def _table(headers: list[str], rows: list[list[str]]) -> str:
    head = "| " + " | ".join(headers) + " |"
    sep = "| " + " | ".join("---" for _ in headers) + " |"
    body = "\n".join("| " + " | ".join(r) + " |" for r in rows) if rows else "| " + " | ".join("—" for _ in headers) + " |"
    return f"{head}\n{sep}\n{body}"


def _findings_md(findings: list[dict[str, str]]) -> str:
    if not findings:
        return "- No findings."
    return "\n".join(f"- **[{f['severity']}]** {f['title']} — {f['detail']}" for f in findings)


def write(run_id: str, content: str) -> str:
    path = report_path_for(run_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(redact_text(content), encoding="utf-8")
    return str(path)


# --- access log -------------------------------------------------------------


def render_access_log(
    run: dict[str, Any],
    dataset: dict[str, Any],
    detected_format: str,
    metrics: dict[str, Any],
    findings: list[dict[str, str]],
    summary: str,
) -> str:
    status_rows = [[d["value"], str(d["count"])] for d in metrics.get("status_code_distribution", [])]
    method_rows = [[d["value"], str(d["count"])] for d in metrics.get("method_distribution", [])]
    hour_rows = [[d["hour"], str(d["count"])] for d in metrics.get("requests_by_hour", [])]
    key_rows = [[d["value"], str(d["count"])] for d in metrics.get("top_keys", [])[:SAMPLE_LIMIT]]
    prefix_rows = [[d["value"], str(d["count"])] for d in metrics.get("top_prefixes", [])]
    ua_rows = [[d["value"], str(d["count"])] for d in metrics.get("top_user_agents", [])]

    return f"""# Access Log Analysis Report

## Summary

{summary}

## Scope

- Run ID: {run.get('id')}
- Run type: access_log_analysis
- Created at: {run.get('created_at')}
- Data source: user-uploaded access-log file (this is the sample provided by the
  user; coverage depends entirely on that file).

## Imported Dataset

- Filename: {dataset.get('source_filename')}
- Detected format: {detected_format}
- Row count: {metrics.get('total_requests', 0)}
- Client IPs: masked (host octet removed, e.g. `192.0.2.x`)

## Metrics

- Total requests: {metrics.get('total_requests', 0)}
- 4xx error rate: {metrics.get('error_rate_4xx', 0):.2%}
- 5xx error rate: {metrics.get('error_rate_5xx', 0):.2%}
- 206 (range) share: {metrics.get('range_share_206', 0):.2%}

## Request Trend

{_table(["Hour", "Requests"], hour_rows)}

## Status Codes

{_table(["Status", "Count"], status_rows)}

## Methods

{_table(["Method", "Count"], method_rows)}

## Top Keys

(at most {SAMPLE_LIMIT} sample keys)

{_table(["Key", "Requests"], key_rows)}

## Top Prefixes

{_table(["Prefix", "Requests"], prefix_rows)}

## Top User Agents

{_table(["User Agent", "Requests"], ua_rows)}

## Findings

{_findings_md(findings)}

## Limitations

- Results reflect only the uploaded sample log; this is not a complete view of
  all traffic.
- At most {SAMPLE_LIMIT} sample keys are shown.
- Findings are threshold-based on the computed metrics, not inferred behavior.

## Safety

- Client IPs are masked; Authorization/Signature/Credential/token values and
  presigned-URL parameters are redacted before persistence.
- No object bodies were downloaded and no S3 mutation was performed.
"""


# --- inventory --------------------------------------------------------------


def render_inventory(
    run: dict[str, Any],
    dataset: dict[str, Any],
    metrics: dict[str, Any],
    findings: list[dict[str, str]],
    summary: str,
) -> str:
    size_rows = [[d["bucket"], str(d["count"])] for d in metrics.get("size_histogram", [])]
    age_rows = [[d["bucket"], str(d["count"])] for d in metrics.get("object_age_distribution", [])]
    prefix_rows = [[d["value"], str(d["count"]), _bytes_h(d["size"])] for d in metrics.get("prefix_distribution", [])]
    storage_rows = [[d["value"], str(d["count"])] for d in metrics.get("storage_class_distribution", [])]
    large_rows = [[o["key"], _bytes_h(o["size"]), o.get("storage_class") or "—"]
                  for o in metrics.get("top_large_objects", [])[:SAMPLE_LIMIT]]

    return f"""# Inventory Analysis Report

## Summary

{summary}

## Scope

- Run ID: {run.get('id')}
- Run type: inventory_analysis
- Created at: {run.get('created_at')}
- Data source: user-uploaded inventory file. Whether this is a full inventory
  depends entirely on the file the user provided.

## Imported Dataset

- Filename: {dataset.get('source_filename')}
- Object count: {metrics.get('object_count', 0)}

## Capacity Overview

- Object count: {metrics.get('object_count', 0)}
- Total size: {_bytes_h(metrics.get('total_size', 0))}
- Average object size: {_bytes_h(metrics.get('average_object_size', 0))}
- Small-object ratio (<1 MiB): {metrics.get('small_object_ratio', 0):.2%}

## Object Size Distribution

{_table(["Size bucket", "Count"], size_rows)}

## Prefix Distribution

{_table(["Prefix", "Objects", "Size"], prefix_rows)}

## Object Age Distribution

{_table(["Age bucket", "Count"], age_rows)}

## Storage Class Distribution

{_table(["Storage class", "Count"], storage_rows)}

## Top Large Objects

(at most {SAMPLE_LIMIT} sample keys)

{_table(["Key", "Size", "Storage class"], large_rows)}

## Findings

{_findings_md(findings)}

## Limitations

- Analysis covers only the uploaded inventory file; completeness depends on that
  file.
- At most {SAMPLE_LIMIT} sample keys are shown.
- Object age requires a parseable `last_modified`; rows without it are bucketed
  as `unknown`.

## Safety

- No object bodies were downloaded.
- No modifying S3 operations were performed; this report only analyzes and
  suggests (e.g. lifecycle opportunities) — it never deletes objects or changes
  lifecycle configuration.
"""
