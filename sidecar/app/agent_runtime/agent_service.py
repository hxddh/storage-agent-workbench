"""Agent planner orchestration (Phase 07).

Coordinates a controlled LLM agent run over the existing whitelisted, read-only
tools. The LLM never sees credentials; tool calls go through the shared
tool_runner; outputs are sanitized/bounded before reaching the model; the final
report is sanitized before saving. The actual LLM loop is behind the
``AGENT_LOOP`` seam so tests can inject a fake without the SDK or an API key.
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Callable
from typing import Any

from .. import config
from ..events import bus
from ..repositories import runs as runs_repo
from ..runs._common import run_tool_with_events
from ..runs.analysis_report import render_agent_report, write
from ..runs.report import report_path_for
from ..security import keyring_store
from ..security.redaction import redact_text
from . import context_builder, guardrails, tool_registry
from .guardrails import GuardrailBlocked
from .prompts import SYSTEM_INSTRUCTIONS
from .result_parser import AgentResult, parse_agent_output

AGENT_SUPPORTED_RUN_TYPES = {"diagnostic", "bucket_config_review"}


class AgentUnavailable(Exception):
    """Agent mode cannot run (no model/key, unsupported type, SDK missing).

    The message is safe to surface to the user.
    """


# --- model credentials (secret stays local to the LLM client) ----------------


def get_model_credentials(conn: sqlite3.Connection) -> dict[str, Any]:
    """Resolve a model provider + its API key from the keyring.

    The API key is a SECRET: it is used only to configure the LLM client and is
    never placed in the context, SSE events, reports, or logs.
    """
    row = conn.execute(
        "SELECT * FROM model_providers ORDER BY created_at, rowid LIMIT 1"
    ).fetchone()
    if row is None:
        raise AgentUnavailable("No model provider configured. Add one under Providers to use Agent mode.")
    api_key = None
    if row["api_key_ref"]:
        scope, name = keyring_store.parse_ref(row["api_key_ref"])
        api_key = keyring_store.get_secret(scope, name)
    if not api_key:
        raise AgentUnavailable("The model provider has no API key stored in the system keyring.")
    return {
        "api_key": api_key,
        "model": row["model"] or "gpt-4o-mini",
        "base_url": row["base_url"],
        "provider_type": row["provider_type"],
    }


# --- tool invoker (guardrailed, event-emitting) ------------------------------


def _short_summary(output: dict[str, Any]) -> str:
    for k in ("identity_hint", "overall_status"):
        if output.get(k):
            return f"{k}={output[k]}"
    bits = []
    if "success" in output:
        bits.append("ok" if output.get("success") else "failed")
    if output.get("error_code"):
        bits.append(f"error={output['error_code']}")
    if isinstance(output.get("findings"), list):
        bits.append(f"{len(output['findings'])} finding(s)")
    if output.get("status_code") is not None:
        bits.append(f"status={output['status_code']}")
    return ", ".join(bits) or "ok"


class ToolInvoker:
    """The only path through which the agent can run a tool."""

    def __init__(self, conn: sqlite3.Connection, run_id: str, ctx: dict[str, Any]):
        self.conn = conn
        self.run_id = run_id
        self.ctx = ctx
        self.evidence: list[dict[str, Any]] = []

    def invoke(self, name: str, args: dict[str, Any] | None = None, reason: str = "") -> dict[str, Any]:
        args = args or {}
        # 1) allowlist / forbidden guardrail
        try:
            guardrails.check_tool_allowed(name)
        except GuardrailBlocked as gb:
            bus.publish(self.run_id, {"type": "guardrail_blocked", "name": gb.name, "message": str(gb)})
            raise
        executor = tool_registry.get_executor(name)
        if executor is None:
            bus.publish(self.run_id, {"type": "guardrail_blocked", "name": "tool_allowlist",
                                      "message": f"Tool '{name}' is not available in agent mode."})
            raise GuardrailBlocked("tool_allowlist", f"Tool '{name}' is not available.")

        bounded_args = guardrails.bound_tool_args(name, args)
        bus.publish(self.run_id, {"type": "agent_tool_selected", "tool_name": name,
                                  "reason": guardrails.strip_chain_of_thought(redact_text(reason))[:160]})
        bus.publish(self.run_id, {"type": "guardrail_passed", "name": "tool_allowlist"})

        # 2) run through the shared tool_runner (records tool_calls + audit, emits SSE)
        full_out = run_tool_with_events(
            self.conn, self.run_id, name,
            {"tool": name, "args": bounded_args,
             "provider_id": self.ctx.get("provider_id"), "bucket": self.ctx.get("bucket")},
            lambda: executor(self.conn, self.ctx, bounded_args),
        )

        # 3) bound + redact before handing back to the LLM
        bounded = guardrails.sanitize_output_for_agent(full_out)
        bus.publish(self.run_id, {"type": "guardrail_passed", "name": "output_sanitization"})
        self.evidence.append({"tool": name, "summary": _short_summary(bounded)})
        return bounded


# --- the LLM loop seam -------------------------------------------------------


def _sdk_agent_loop(spec: dict[str, Any]) -> AgentResult:
    """Default loop using the OpenAI Agents SDK (lazy import, best-effort).

    Any failure here (missing SDK, client/runtime error) is surfaced as
    AgentUnavailable so the run fails cleanly; deterministic mode is unaffected.
    Tests replace ``AGENT_LOOP`` so this is never exercised without a real key.
    """
    try:
        import openai  # noqa: F401
        from agents import Agent, Runner, function_tool, set_default_openai_key
    except Exception as exc:  # noqa: BLE001
        raise AgentUnavailable("OpenAI Agents SDK is not available in this environment.") from exc

    invoker: ToolInvoker = spec["invoker"]
    creds = spec["creds"]

    def _make_tool(name: str):
        desc = tool_registry.TOOL_SPECS.get(name, name)
        if name == "list_objects_v2":
            @function_tool
            def _tool(max_keys: int = 100, prefix: str = "") -> str:
                """List a bounded object sample."""
                return json.dumps(invoker.invoke(name, {"max_keys": max_keys, "prefix": prefix or None}, "agent-selected"))
        elif name == "head_object":
            @function_tool
            def _tool(key: str) -> str:
                """Read metadata for one object key."""
                return json.dumps(invoker.invoke(name, {"key": key}, "agent-selected"))
        else:
            @function_tool
            def _tool() -> str:
                """Run a read-only inspection tool."""
                return json.dumps(invoker.invoke(name, {}, "agent-selected"))
        _tool.name = name  # type: ignore[attr-defined]
        _tool.__doc__ = desc
        return _tool

    try:
        if creds.get("base_url"):
            from agents import set_default_openai_client
            client = openai.AsyncOpenAI(api_key=creds["api_key"], base_url=creds["base_url"])
            set_default_openai_client(client)
        else:
            set_default_openai_key(creds["api_key"])

        tools = [_make_tool(n) for n in spec.get("tool_names", [])]
        agent = Agent(name="Storage Agent Workbench", instructions=spec["instructions"],
                      tools=tools, model=creds.get("model"))
        result = Runner.run_sync(agent, spec["context_text"])
        return parse_agent_output(getattr(result, "final_output", ""))
    except AgentUnavailable:
        raise
    except Exception as exc:  # noqa: BLE001
        raise AgentUnavailable(f"Agent execution failed: {redact_text(str(exc))}") from exc


# Monkeypatch this in tests to inject a fake loop (no SDK / no API key needed).
AGENT_LOOP: Callable[[dict[str, Any]], AgentResult] = _sdk_agent_loop


# --- orchestration -----------------------------------------------------------


def _plan_text(run_type: str) -> str:
    tools = tool_registry.TOOLS_FOR_RUN_TYPE.get(run_type, [])
    steps = [f"Consider read-only tool: {t}" for t in tools]
    steps.append("Interpret sanitized tool outputs into findings.")
    steps.append("Write a grounded narrative; the report is sanitized before saving.")
    return "\n".join(f"{i}. {s}" for i, s in enumerate(steps, 1))


def run_agent(conn: sqlite3.Connection, run_id: str) -> None:
    row = runs_repo.get_row(conn, run_id)
    if row is None:
        bus.publish(run_id, {"type": "error", "message": "run not found"})
        bus.mark_done(run_id)
        return
    run = dict(row)

    try:
        if run["run_type"] not in AGENT_SUPPORTED_RUN_TYPES:
            raise AgentUnavailable(f"Agent mode is not supported yet for run_type '{run['run_type']}'.")
        if not run.get("provider_id") or not run.get("bucket"):
            raise AgentUnavailable("Agent mode requires a provider and bucket.")

        creds = get_model_credentials(conn)  # raises AgentUnavailable if missing
        tool_registry.assert_registry_is_safe()

        prov = conn.execute(
            "SELECT endpoint_url FROM cloud_providers WHERE id = ?", (run["provider_id"],)
        ).fetchone()
        ctx = {
            "provider_id": run["provider_id"],
            "bucket": run["bucket"],
            "prefix": run["prefix"],
            "endpoint_url": prov["endpoint_url"] if prov else None,
        }
        context = context_builder.build_context(conn, run)  # asserts no secrets

        runs_repo.set_status(conn, run_id, "running")
        bus.publish(run_id, {"type": "agent_started", "planner_mode": "agent"})
        bus.publish(run_id, {"type": "agent_plan", "content": _plan_text(run["run_type"])})

        invoker = ToolInvoker(conn, run_id, ctx)
        spec = {
            "context": context,
            "context_text": context_builder.render_context_text(context),
            "instructions": SYSTEM_INSTRUCTIONS,
            "run_type": run["run_type"],
            "tool_names": tool_registry.TOOLS_FOR_RUN_TYPE.get(run["run_type"], []),
            "invoker": invoker,
            "creds": creds,
        }
        result = AGENT_LOOP(spec)
        if not isinstance(result, AgentResult):
            result = parse_agent_output(result)

        # Defense in depth: never trust the loop to have stripped reasoning.
        safe_summary = guardrails.strip_chain_of_thought(result.summary)
        safe_narrative = guardrails.strip_chain_of_thought(result.report_narrative)

        for f in result.findings:
            bus.publish(run_id, {"type": "finding", "severity": f.get("severity", "info"),
                                 "title": f.get("title", ""), "detail": f.get("detail", "")})
        bus.publish(run_id, {"type": "agent_final", "content": safe_summary})

        content = render_agent_report(run, safe_summary, safe_narrative, result.findings, invoker.evidence)
        guardrails.assert_report_sanitized(content)  # raises GuardrailBlocked if not clean
        write(run_id, content)
        report_abs = str(report_path_for(run_id))
        conn.execute(
            "INSERT INTO reports (id, run_id, report_path, format, created_at) "
            "VALUES (lower(hex(randomblob(16))), ?, ?, 'markdown', datetime('now'))",
            (run_id, report_abs),
        )
        conn.commit()
        runs_repo.set_status(conn, run_id, "completed",
                             final_summary=safe_summary or "Agent run completed.", report_path=report_abs)
        bus.publish(run_id, {"type": "report_ready", "run_id": run_id, "report_path": config.rel_path(report_abs)})
    except (AgentUnavailable, GuardrailBlocked) as exc:
        runs_repo.set_status(conn, run_id, "failed", final_summary="Agent run did not complete.")
        bus.publish(run_id, {"type": "error", "message": redact_text(str(exc))})
    except Exception as exc:  # noqa: BLE001 - sanitized below
        runs_repo.set_status(conn, run_id, "failed", final_summary="Agent run failed.")
        bus.publish(run_id, {"type": "error", "message": redact_text(str(exc))})
    finally:
        bus.mark_done(run_id)
