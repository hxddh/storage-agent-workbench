"""Agent narrator for dataset-analysis runs (Phase 13).

Extends the agent planner to ``access_log_analysis`` and ``inventory_analysis``.
Unlike the diagnostic/config planner (Phase 07), this path is **interpretation
only**: the deterministic analysis runs first and produces metrics + findings,
then the model is given ONLY a bounded, sanitized, aggregated context (run +
dataset metadata + deterministic metrics + deterministic findings) and asked to
write a structured narrative.

Why no tools: the model never calls a tool here, so it has no path to raw log
lines, raw inventory rows, full key lists, arbitrary SQL, object bodies, or any
mutating/destructive S3 operation. The only thing it can read is the sanitized
aggregate context this module builds. The real LLM call is behind the
``ANALYSIS_LOOP`` seam so tests inject a fake (no SDK / no API key needed).

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
    "You receive ONLY pre-computed, aggregated, redacted metrics and findings.",
    "You have NO tools: you cannot run SQL, read raw logs/rows, list objects, "
    "download bodies, or call any S3 API.",
    "Treat the deterministic metrics and findings as the only ground truth; "
    "every claim you make must be traceable to a number or finding shown to you.",
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


# --- the LLM loop seam (no tools) -------------------------------------------


def _sdk_analysis_loop(spec: dict[str, Any]) -> Any:
    """Default one-shot loop via the OpenAI Agents SDK (lazy import, no tools).

    Any failure (missing SDK, client/runtime error) surfaces as AgentUnavailable
    so the run fails cleanly. Tests replace ``ANALYSIS_LOOP`` so this is never
    exercised without a real key.
    """
    try:
        import openai  # noqa: F401
        from agents import Agent, Runner, set_default_openai_key
    except Exception as exc:  # noqa: BLE001
        raise AgentUnavailable("OpenAI Agents SDK is not available in this environment.") from exc

    creds = spec["creds"]
    try:
        if creds.get("base_url"):
            from agents import set_default_openai_client
            client = openai.AsyncOpenAI(api_key=creds["api_key"], base_url=creds["base_url"])
            set_default_openai_client(client)
        else:
            set_default_openai_key(creds["api_key"])

        # No tools: the model can only read the sanitized context we pass in.
        agent = Agent(
            name="Storage Analysis Narrator",
            instructions=spec["instructions"],
            tools=[],
            model=creds.get("model"),
        )
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
) -> dict[str, Any]:
    """Run the interpretation-only agent over sanitized aggregates.

    Returns the parsed, sanitized field dict. Raises AgentUnavailable on failure.
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
