"""Agent narrator for dataset-analysis runs (Phase 13).

Extends the agent planner to ``access_log_analysis`` and ``inventory_analysis``.
Unlike the diagnostic/config planner (Phase 07), this path is **interpretation
first**: the deterministic analysis runs first and produces metrics + findings,
then the model is given a bounded, sanitized, aggregated context (run + dataset
metadata + deterministic metrics + deterministic findings) and asked to write a
structured narrative.

Drill-down (Phase 2): the narrator additionally gets two *bounded, read-only
aggregate* tools over the already-local DuckDB dataset (``analysis.drilldown``)
so it can ask follow-up questions ("which prefixes carry the 5xx?") instead of
being frozen to one pre-computed view. It still has NO path to raw log lines,
inventory rows, full key lists, arbitrary SQL, object bodies, or any
mutating/destructive S3 op — only whitelisted GROUP BY / COUNT aggregates run,
with the filter value always bound, never inlined. The real LLM call is behind
the ``ANALYSIS_LOOP`` seam so tests inject a fake (no SDK / no API key needed).

Guarantees enforced in code (not just the prompt):
- context is bounded (lists capped at SAMPLE_LIMIT=20) and redacted, and is
  asserted to contain no secret-shaped content before it can leave the process;
- the model output is redacted, chain-of-thought-stripped, length-bounded, and
  coerced to the allowed field set;
- no new tool is registered (the tool allowlist is unchanged).
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

from ..security.redaction import redact_text
from . import guardrails
from .agent_service import AgentUnavailable
from .guardrails import SAMPLE_LIMIT, strip_chain_of_thought

ANALYSIS_SUPPORTED_RUN_TYPES = {"access_log_analysis", "inventory_analysis"}

# Output field shapes per run type. "str" -> single text block, "list" -> bullets.
_ACCESS_LOG_FIELDS: dict[str, str] = {
    "executive_summary": "str",
    "key_observations": "list",
    "possible_root_causes": "list",
    "risk_level": "str",
    "recommended_next_steps": "list",
    "questions_for_operator": "list",
    "limitations": "str",
}
_INVENTORY_FIELDS: dict[str, str] = {
    "executive_summary": "str",
    "storage_layout_observations": "list",
    "cost_optimization_opportunities": "list",
    "performance_considerations": "list",
    "lifecycle_policy_candidates": "list",
    "small_object_findings": "list",
    "large_object_findings": "list",
    "risks_and_caveats": "list",
    "recommended_next_steps": "list",
}


def fields_for(run_type: str) -> dict[str, str]:
    return _ACCESS_LOG_FIELDS if run_type == "access_log_analysis" else _INVENTORY_FIELDS


# --- prompts ----------------------------------------------------------------

ANALYSIS_SAFETY_RULES = [
    "You receive pre-computed, aggregated, redacted metrics and findings.",
    "You MAY drill down with two bounded, read-only aggregate tools over the "
    "already-local dataset — aggregate_by(dimension, metric, limit) and "
    "count_where(field, op, value) — to investigate the metrics further (e.g. "
    "which prefixes carry the 5xx errors). You CANNOT run free SQL, read raw "
    "log lines / inventory rows / object keys, download bodies, or call any S3 "
    "API; only whitelisted aggregates are available.",
    "Treat the deterministic metrics, findings, and any drill-down aggregates "
    "you fetch as the only ground truth; every claim must be traceable to one "
    "of them.",
    "Do not invent raw log lines, object keys, IPs, byte counts, or timestamps "
    "that are not present in the context.",
    "Never output credentials, access/secret/session keys, model API keys, "
    "Authorization headers, cookies, signatures, or presigned-URL parameters.",
    "Never recommend or emit destructive or mutating operations (deletes, bulk "
    "object mutation, PutBucketPolicy/Acl/Lifecycle). You may suggest the "
    "operator REVIEW lifecycle candidates, but must not create/change them.",
    "Do not include hidden chain-of-thought; output only the requested JSON.",
]

_ACCESS_LOG_INSTRUCTIONS = (
    "You are a senior storage/access-log analyst. You are given a JSON context "
    "with run metadata, dataset metadata, deterministic access-log metrics, and "
    "deterministic findings. Interpret them for an operator.\n\n"
    "Respond with a SINGLE JSON object (no prose outside it, no markdown fences) "
    "with exactly these keys:\n"
    "  executive_summary (string),\n"
    "  key_observations (array of short strings),\n"
    "  possible_root_causes (array of short strings),\n"
    "  risk_level (one of: low, medium, high),\n"
    "  recommended_next_steps (array of short strings),\n"
    "  questions_for_operator (array of short strings),\n"
    "  limitations (string).\n\n"
    "Ground every statement in the provided metrics/findings. If the data is "
    "insufficient, say so in limitations rather than guessing. Follow all "
    "safety_rules in the context."
)

_INVENTORY_INSTRUCTIONS = (
    "You are a senior storage-capacity and cost analyst. You are given a JSON "
    "context with run metadata, dataset metadata, deterministic inventory "
    "metrics, and deterministic findings. Interpret them for an operator.\n\n"
    "Respond with a SINGLE JSON object (no prose outside it, no markdown fences) "
    "with exactly these keys:\n"
    "  executive_summary (string),\n"
    "  storage_layout_observations (array of short strings),\n"
    "  cost_optimization_opportunities (array of short strings),\n"
    "  performance_considerations (array of short strings),\n"
    "  lifecycle_policy_candidates (array of short strings),\n"
    "  small_object_findings (array of short strings),\n"
    "  large_object_findings (array of short strings),\n"
    "  risks_and_caveats (array of short strings),\n"
    "  recommended_next_steps (array of short strings).\n\n"
    "Ground every statement in the provided metrics/findings. You MAY recommend "
    "that the operator review lifecycle-policy candidates, but you must NOT "
    "produce delete commands or lifecycle/policy mutations. Follow all "
    "safety_rules in the context."
)


def _instructions_for(run_type: str) -> str:
    return _ACCESS_LOG_INSTRUCTIONS if run_type == "access_log_analysis" else _INVENTORY_INSTRUCTIONS


# --- sanitized, bounded context ---------------------------------------------


def build_analysis_context(
    run: dict[str, Any],
    dataset_meta: dict[str, Any],
    metrics: dict[str, Any],
    findings: list[dict[str, str]],
) -> dict[str, Any]:
    """Build the ONLY data the model will see: bounded + redacted aggregates."""
    context = {
        "run": {
            "run_id": run.get("id"),
            "run_type": run.get("run_type"),
            "created_at": str(run.get("created_at")),
            "user_prompt": redact_text(run.get("user_prompt") or ""),
        },
        "dataset": {
            "source_filename": dataset_meta.get("source_filename"),
            "dataset_type": dataset_meta.get("dataset_type"),
            "row_count": dataset_meta.get("row_count"),
            "detected_format": dataset_meta.get("detected_format"),
        },
        # sanitize_output_for_agent caps every list at SAMPLE_LIMIT and redacts
        # secret-shaped values; raw/headers/policy/acl/data keys are dropped.
        "deterministic_metrics": guardrails.sanitize_output_for_agent(metrics),
        "deterministic_findings": [
            {
                "severity": str(f.get("severity", "info"))[:32],
                "title": redact_text(str(f.get("title", "")))[:200],
                "detail": redact_text(str(f.get("detail", "")))[:600],
            }
            for f in (findings or [])[:SAMPLE_LIMIT]
        ],
        "safety_rules": ANALYSIS_SAFETY_RULES,
    }
    # Hard stop: never let secret-shaped content reach the model.
    guardrails.assert_no_secrets_in_context(context)
    return context


def render_context_text(context: dict[str, Any]) -> str:
    return json.dumps(context, indent=2, default=str)


# --- output parsing / sanitization ------------------------------------------

_MAX_TEXT = 2000
_MAX_ITEM = 600


def parse_analysis_output(run_type: str, raw: Any) -> dict[str, Any]:
    """Coerce the model output into the allowed field set, fully sanitized."""
    schema = fields_for(run_type)
    if isinstance(raw, str):
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            data = {"executive_summary": raw}
    elif isinstance(raw, dict):
        data = raw
    else:
        data = {}

    out: dict[str, Any] = {}
    for key, kind in schema.items():
        val = data.get(key)
        if kind == "list":
            items = val if isinstance(val, list) else ([val] if val not in (None, "") else [])
            cleaned: list[str] = []
            for item in items[:SAMPLE_LIMIT]:
                text = strip_chain_of_thought(redact_text(str(item)))[:_MAX_ITEM]
                if text:
                    cleaned.append(text)
            out[key] = cleaned
        else:
            text = "" if val is None else str(val)
            out[key] = strip_chain_of_thought(redact_text(text))[:_MAX_TEXT]
    return out


# --- bounded drill-down tools over the local dataset ------------------------

# run_type -> the DuckDB table the deterministic pass populated.
_TABLE_FOR = {
    "access_log_analysis": "access_logs",
    "inventory_analysis": "inventory_objects",
}


def build_drilldown_tools(function_tool: Any, duckdb_path: str, table: str) -> list[Any]:
    """Two bounded, read-only aggregate tools over the run's local DuckDB table.

    Returns [] if the table is unknown. Every query is a whitelisted GROUP BY or
    COUNT (see ``analysis.drilldown``); raw rows / free SQL / bodies are
    unreachable, and the filter value is always a bound parameter.
    """
    from ..analysis import drilldown
    try:
        dims = drilldown.dimensions(table)
        mets = drilldown.metrics(table)
        flds = drilldown.filters(table)
    except drilldown.DrillError:
        return []

    @function_tool
    def aggregate_by(dimension: str, metric: str = "count", limit: int = 20) -> str:
        """Group the dataset by one dimension and rank by one aggregate metric (read-only; top results only, no raw rows). Args: dimension (one of the allowed dimensions), metric (one of the allowed metrics, default count), limit (<=50)."""
        try:
            rows = drilldown.aggregate_by(duckdb_path, table, dimension, metric, limit)
        except drilldown.DrillError as exc:
            return json.dumps({"error": str(exc)})
        return json.dumps({"dimension": dimension, "metric": metric, "rows": rows})

    @function_tool
    def count_where(field: str, op: str, value: str) -> str:
        """Count rows where one field compares to a value (read-only single aggregate). Args: field (one of the allowed fields), op (one of = != < <= > >=), value (the value to compare; bound as a parameter)."""
        try:
            n = drilldown.count_where(duckdb_path, table, field, op, value)
        except drilldown.DrillError as exc:
            return json.dumps({"error": str(exc)})
        return json.dumps({"field": field, "op": op, "value": value, "count": n})

    aggregate_by.__doc__ = (
        (aggregate_by.__doc__ or "")
        + f"\nAllowed dimensions: {dims}. Allowed metrics: {mets}."
    )
    count_where.__doc__ = (count_where.__doc__ or "") + f"\nAllowed fields: {flds}."
    return [aggregate_by, count_where]


# --- the LLM loop seam (interpretation + bounded drill-down) -----------------


def _sdk_analysis_loop(spec: dict[str, Any]) -> Any:
    """Default loop via the OpenAI Agents SDK (lazy import) with bounded
    drill-down aggregate tools over the run's local dataset.

    Any failure (missing SDK, client/runtime error) surfaces as AgentUnavailable
    so the run fails cleanly. Tests replace ``ANALYSIS_LOOP`` so this is never
    exercised without a real key.
    """
    try:
        import openai  # noqa: F401
        from agents import Runner, function_tool
    except Exception as exc:  # noqa: BLE001
        raise AgentUnavailable("OpenAI Agents SDK is not available in this environment.") from exc

    creds = spec["creds"]
    try:
        # The model can read the sanitized context plus a few bounded, read-only
        # aggregates over the already-local dataset. Uses the shared per-run
        # client builder (no SDK globals → concurrency-safe).
        from .agent_service import build_agent
        tools: list[Any] = []
        duckdb_path = spec.get("duckdb_path")
        table = spec.get("table")
        if duckdb_path and table:
            tools = build_drilldown_tools(function_tool, duckdb_path, table)
        agent = build_agent(creds, tools, spec["instructions"], name="Storage Analysis Narrator")
        result = Runner.run_sync(agent, spec["context_text"])
        return getattr(result, "final_output", "")
    except AgentUnavailable:
        raise
    except Exception as exc:  # noqa: BLE001
        raise AgentUnavailable(f"Agent execution failed: {redact_text(str(exc))}") from exc


# Monkeypatch this in tests to inject a fake loop (no SDK / no API key needed).
ANALYSIS_LOOP: Callable[[dict[str, Any]], Any] = _sdk_analysis_loop


# --- orchestration ----------------------------------------------------------


def interpret(
    run_type: str,
    run: dict[str, Any],
    dataset_meta: dict[str, Any],
    metrics: dict[str, Any],
    findings: list[dict[str, str]],
    creds: dict[str, Any],
    duckdb_path: str | None = None,
) -> dict[str, Any]:
    """Run the interpretation narrator over sanitized aggregates.

    When ``duckdb_path`` is given, the narrator also gets bounded, read-only
    drill-down aggregate tools over that local dataset (see
    ``build_drilldown_tools``). Returns the parsed, sanitized field dict. Raises
    AgentUnavailable on failure.
    """
    if run_type not in ANALYSIS_SUPPORTED_RUN_TYPES:
        raise AgentUnavailable(f"Agent narration is not supported for run_type '{run_type}'.")
    context = build_analysis_context(run, dataset_meta, metrics, findings)
    spec = {
        "context": context,
        "context_text": render_context_text(context),
        "instructions": _instructions_for(run_type),
        "run_type": run_type,
        "creds": creds,
        "duckdb_path": duckdb_path,
        "table": _TABLE_FOR.get(run_type),
    }
    raw = ANALYSIS_LOOP(spec)
    return parse_analysis_output(run_type, raw)


__all__ = [
    "ANALYSIS_SUPPORTED_RUN_TYPES",
    "ANALYSIS_SAFETY_RULES",
    "ANALYSIS_LOOP",
    "build_analysis_context",
    "render_context_text",
    "parse_analysis_output",
    "interpret",
    "fields_for",
]
