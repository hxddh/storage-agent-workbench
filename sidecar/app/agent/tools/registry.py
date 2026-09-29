"""The tool registry (v5): one declaration, one path.

A tool is a plain function with typed parameters and a docstring, declared with
``@tool(...)``. The registry turns it into an Agents SDK ``FunctionTool`` whose
every call goes through the same path:

1. **Scope guardrail** (SDK ``tool_input_guardrails``): the provider must exist
   and the bucket / prefix / key must be inside its allow-list. A refusal goes
   back to the model as a message and is recorded like any other call.
2. **Bounds**: numeric arguments are clamped to the tool's declared limits.
3. **Execution** in a worker thread with a per-call connection, under the
   SDK's own ``timeout_seconds`` (the handler is async, so the SDK enforces it).
4. **Sanitizing**: the result is redacted; the model receives it bounded and
   wrapped in the untrusted-data envelope; the UI receives a one-line summary
   and a bounded detail.
5. **Recording**: ``tool_call`` and ``tool_output`` items and one audit row.

Tool bodies read their runtime context (task, turn, progress, cancel, a DB
connection) from ``current()`` — so their signatures stay plain and the SDK
derives the JSON schema from them directly.
"""

from __future__ import annotations

import asyncio
import contextvars
import json
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from ... import db
from ...s3.scope import check_scope
from ...security.redaction import redact, redact_text
from .. import safety

# --- declaration -------------------------------------------------------------------


@dataclass(frozen=True)
class Scope:
    """Which parameters name storage, and whether the call lists objects."""
    provider: str = "provider_id"
    bucket: str | None = "bucket"
    key: str | None = None
    prefix: str | None = None
    listing: bool = False


@dataclass
class ToolDef:
    name: str
    fn: Callable[..., Any]
    group: str
    core: bool = False
    timeout: float = 60.0
    scope: Scope | None = None
    bounds: dict[str, tuple[int, int]] = field(default_factory=dict)
    summarize: Callable[[Any], str] | None = None
    untrusted: bool = True
    max_model_chars: int = 60_000
    special: str | None = None  # "conclusion": recorded as a conclusion item


REGISTRY: dict[str, ToolDef] = {}

GROUPS: dict[str, str] = {
    "core": "Orientation: providers, buckets, skills, the estate and the conclusion.",
    "probes": "Endpoint and credential probes: reachability, TLS, addressing, latency, presigned URLs.",
    "objects": "Object forensics: listing, versions, multipart uploads, heads, ACLs, tags, lock, previews.",
    "config": "Bucket configuration: summary, detail per aspect, security / lifecycle / cost / performance reviews.",
    "account": "Account-wide: survey every bucket, compare with the last survey, query posture.",
    "files": "Local analysis of attached files and imported evidence: analyze, aggregate, import evidence.",
    "advice": "Deterministic advice: error triage, cost and lifecycle simulation.",
}


def tool(*, group: str, core: bool = False, timeout: float = 60.0, scope: Scope | None = None,
         bounds: dict[str, tuple[int, int]] | None = None, summarize: Callable[[Any], str] | None = None,
         untrusted: bool = True, max_model_chars: int = 60_000, special: str | None = None,
         name: str | None = None) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    def deco(fn: Callable[..., Any]) -> Callable[..., Any]:
        tool_name = name or fn.__name__
        if safety.is_forbidden_tool(tool_name):
            raise ValueError(f"forbidden tool name: {tool_name}")
        if group not in GROUPS:
            raise ValueError(f"unknown tool group: {group}")
        REGISTRY[tool_name] = ToolDef(tool_name, fn, group, core, timeout, scope, dict(bounds or {}),
                                      summarize, untrusted, max_model_chars, special)
        return fn
    return deco


# --- runtime context -----------------------------------------------------------------


@dataclass
class TurnContext:
    """What a turn's tools can reach. Passed to the SDK as the run context."""
    task_id: str
    turn_id: str
    cancel: threading.Event
    recorder: Any  # agent.recorder.Recorder
    budgets: dict[str, dict[str, int]] = field(default_factory=dict)
    lang: str = "en"


class StopSignal:
    """Set when the user stops the turn OR this one call timed out. Tool bodies
    check it between units of work (a bucket, a file, a check) and return what
    they have — a thread cannot be killed, so a call ends at its next check."""

    def __init__(self, turn_cancel: threading.Event) -> None:
        self._turn = turn_cancel
        self._own = threading.Event()

    def set(self) -> None:
        self._own.set()

    def is_set(self) -> bool:
        return self._own.is_set() or self._turn.is_set()


@dataclass
class CallContext:
    turn: TurnContext
    call_id: str
    tool: str
    _conn: Any = None
    stop: StopSignal | None = None

    def __post_init__(self) -> None:
        if self.stop is None:
            self.stop = StopSignal(self.turn.cancel)

    @property
    def task_id(self) -> str:
        return self.turn.task_id

    @property
    def turn_id(self) -> str:
        return self.turn.turn_id

    @property
    def cancelled(self) -> bool:
        return self.stop.is_set()  # type: ignore[union-attr]

    def conn(self):
        if self._conn is None:
            self._conn = db.connect()
        return self._conn

    def progress(self, done: int, total: int, unit: str) -> None:
        self.turn.recorder.progress(self.call_id, self.tool, done, total, unit)

    def remaining(self, key: str, limit: int) -> int:
        """What is left of a per-turn budget, without spending it."""
        return max(0, limit - self.turn.budgets.get(self.tool, {}).get(key, 0))

    def budget(self, key: str, limit: int, cost: int = 1) -> bool:
        """Spend from a per-turn budget; False when it would go over."""
        spent = self.turn.budgets.setdefault(self.tool, {}).get(key, 0)
        if spent + cost > limit:
            return False
        self.turn.budgets[self.tool][key] = spent + cost
        return True

    def close(self) -> None:
        if self._conn is not None:
            try:
                self._conn.close()
            except Exception:  # noqa: BLE001
                pass
            self._conn = None


_current: contextvars.ContextVar[CallContext | None] = contextvars.ContextVar("storage_agent_call", default=None)


def current() -> CallContext:
    ctx = _current.get()
    if ctx is None:
        raise RuntimeError("tool called outside an Agent turn")
    return ctx


# --- helpers ---------------------------------------------------------------------------


def compact_json(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), default=str, ensure_ascii=False)


def default_summary(result: Any) -> str:
    if isinstance(result, dict):
        if result.get("error"):
            return str(result["error"])[:120]
        if result.get("success") is False:
            code = str(result.get("error_code") or "failed")
            rid = result.get("request_id")
            return f"{code} · req {str(rid)[:24]}" if rid else code
        for key in ("buckets", "objects", "keys", "versions", "uploads", "parts", "groups", "findings", "rows"):
            if isinstance(result.get(key), list):
                return f"{len(result[key])} {key}"
        if result.get("summary") and isinstance(result["summary"], str):
            return result["summary"][:160]
        return "ok"
    if isinstance(result, str):
        return result[:160]
    return "done"


def _ok(result: Any) -> bool:
    return not (isinstance(result, dict) and (result.get("success") is False or "error" in result))


def _target(args: dict[str, Any]) -> str:
    bucket, key = args.get("bucket"), args.get("key")
    if bucket and key:
        return f"{bucket}/{key}"
    return str(bucket or args.get("name") or args.get("dataset_id") or args.get("provider_id") or "")[:200]


def _bounded_for_model(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return (text[:limit] + f"\n[TRUNCATED: {len(text) - limit} more characters. Narrow the request "
            "(a prefix, a smaller page, one aspect) to see the rest.]")


def _clamp(args: dict[str, Any], bounds: dict[str, tuple[int, int]]) -> dict[str, Any]:
    out = dict(args)
    for name, (lo, hi) in bounds.items():
        if name in out and out[name] is not None:
            try:
                out[name] = max(lo, min(hi, int(out[name])))
            except (TypeError, ValueError):
                out[name] = lo
    return out


# --- scope guardrail ---------------------------------------------------------------------


def scope_denial(td: ToolDef, args: dict[str, Any]) -> str | None:
    if td.scope is None:
        return None
    provider_id = args.get(td.scope.provider)
    if not provider_id:
        return None
    from ...providers import clouds
    conn = db.connect()
    try:
        cloud = clouds.get(conn, str(provider_id))
    finally:
        conn.close()
    if cloud is None:
        return f"Unknown provider_id {provider_id!r}. Use one from configured_providers."
    bucket = args.get(td.scope.bucket) if td.scope.bucket else None
    if not bucket:
        return None
    return check_scope(cloud.allowed_buckets, cloud.allowed_prefixes, str(bucket),
                       key=args.get(td.scope.key) if td.scope.key else None,
                       prefix=args.get(td.scope.prefix) if td.scope.prefix else None,
                       listing=td.scope.listing)


# --- SDK binding ------------------------------------------------------------------------------


def _parse_args(raw: str) -> dict[str, Any]:
    try:
        value = json.loads(raw or "{}")
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def build_sdk_tools(*, responses: bool, names: set[str] | None = None) -> list[Any]:
    """FunctionTools for this turn. On the Responses backend non-core groups
    become deferred namespaces behind hosted tool search; elsewhere every tool
    is sent (Chat Completions has no tool search)."""
    from agents import FunctionTool, ToolGuardrailFunctionOutput, tool_input_guardrail, tool_namespace
    from agents.function_schema import function_schema

    tools_by_group: dict[str, list[Any]] = {}
    for td in REGISTRY.values():
        if names is not None and td.name not in names:
            continue
        schema = function_schema(td.fn, strict_json_schema=True)

        @tool_input_guardrail(name=f"scope:{td.name}")
        def _scope_guard(data, _td=td):  # type: ignore[no-untyped-def]
            args = _parse_args(getattr(data.context, "tool_arguments", "") or "")
            denial = scope_denial(_td, args)
            if denial is None:
                return ToolGuardrailFunctionOutput.allow()
            turn: TurnContext = data.context.context
            turn.recorder.tool_refused(data.context.tool_call_id, _td.name, redact(args), denial)
            return ToolGuardrailFunctionOutput.reject_content(f"Refused: {denial}")

        async def _invoke(tool_ctx, raw_args: str, _td=td):  # type: ignore[no-untyped-def]
            return await invoke(_td, tool_ctx, raw_args)

        ft = FunctionTool(
            name=td.name,
            description=schema.description or td.name,
            params_json_schema=schema.params_json_schema,
            on_invoke_tool=_invoke,
            strict_json_schema=True,
            tool_input_guardrails=[_scope_guard] if td.scope else None,
            timeout_seconds=td.timeout,
            defer_loading=responses and not td.core,
        )
        tools_by_group.setdefault(td.group, []).append(ft)

    out: list[Any] = []
    for group, tools in tools_by_group.items():
        if responses and group != "core":
            out.extend(tool_namespace(name=group, description=GROUPS[group], tools=tools))
        else:
            out.extend(tools)
    return out


async def invoke(td: ToolDef, tool_ctx: Any, raw_args: str) -> str:
    turn: TurnContext = tool_ctx.context
    call_id = getattr(tool_ctx, "tool_call_id", None) or f"call-{time.monotonic_ns()}"
    args = _clamp(_parse_args(raw_args), td.bounds)
    safe_args = redact(args)
    if td.special == "conclusion":
        return turn.recorder.conclusion(call_id, args)
    turn.recorder.tool_started(call_id, td.name, safe_args, _target(args))
    if turn.cancel.is_set():
        turn.recorder.tool_finished(call_id, td.name, False, "stopped", None, 0)
        return "Stopped by the user before this call ran."
    call = CallContext(turn, call_id, td.name)
    started = time.monotonic()

    def run() -> Any:
        token = _current.set(call)
        try:
            return td.fn(**args)
        finally:
            _current.reset(token)
            call.close()

    try:
        result = await asyncio.to_thread(contextvars.copy_context().run, run)
    except asyncio.CancelledError:
        # Timeout or Stop: the SDK cancelled us. Tell the body to stop at its next
        # check, record it, then let the cancellation propagate.
        call.stop.set()  # type: ignore[union-attr]
        turn.recorder.tool_finished(call_id, td.name, False, "cancelled or timed out", None,
                                    int((time.monotonic() - started) * 1000))
        raise
    except TypeError as exc:
        result = {"error": f"Invalid arguments: {redact_text(str(exc))[:300]}"}
    except Exception as exc:  # noqa: BLE001 — every failure is a result the model can read
        result = {"success": False, "error_code": type(exc).__name__,
                  "error_message_sanitized": redact_text(str(exc))[:500]}
    duration_ms = int((time.monotonic() - started) * 1000)
    clean = redact(result)
    ok = _ok(clean)
    summary = redact_text((td.summarize or default_summary)(clean))[:240]
    text = clean if isinstance(clean, str) else compact_json(clean)
    text = _bounded_for_model(text, td.max_model_chars)
    model_text = safety.envelope(text) if td.untrusted else text
    turn.recorder.tool_finished(call_id, td.name, ok, summary, clean, duration_ms, model_text=model_text)
    return model_text


def run_direct(conn: Any, name: str, args: dict[str, Any], fn: Callable[[], Any], *, actor: str) -> Any:
    """Run one read-only engine call outside a turn (a Settings test, a Verify):
    same redaction as a tool call, audited with its actor."""
    from ...core import store
    started = time.monotonic()
    try:
        result = fn()
    except Exception as exc:  # noqa: BLE001 — returned as a sanitized failure
        result = {"success": False, "error_code": type(exc).__name__,
                  "error_message_sanitized": redact_text(str(exc))[:300]}
    result = redact(result)
    store.audit(conn, actor=actor, action=f"tool.{name}", target=_target(args), ok=_ok(result),
                duration_ms=int((time.monotonic() - started) * 1000), detail={"args": redact(args)})
    return result


class _DetachedRecorder:
    """A recorder for calls made outside a turn (the MCP bridge): nothing to stream."""

    def progress(self, *_a: Any, **_k: Any) -> None:
        return None


def call_direct(name: str, args: dict[str, Any], *, actor: str, allowed: frozenset[str]) -> Any:
    """Run one registered tool outside a turn — same scope check, bounds and
    redaction as inside one, audited with its actor. Only ``allowed`` tools."""
    from ...core import store
    td = REGISTRY.get(name)
    if td is None or name not in allowed:
        return {"error": f"Unknown tool: {name}"}
    args = _clamp(dict(args or {}), td.bounds)
    denial = scope_denial(td, args)
    conn = db.connect()
    try:
        if denial:
            store.audit(conn, actor=actor, action=f"tool.{name}", target=_target(args), ok=False,
                        detail={"refused": denial})
            return {"error": f"Refused: {denial}"}
        turn = TurnContext("", "", threading.Event(), _DetachedRecorder())
        call = CallContext(turn, f"{actor}-{time.monotonic_ns()}", name)

        def fn() -> Any:
            token = _current.set(call)
            try:
                return td.fn(**args)
            finally:
                _current.reset(token)
                call.close()

        result = run_direct(conn, name, args, fn, actor=actor)
        text = result if isinstance(result, str) else compact_json(result)
        if len(text) > td.max_model_chars:
            return {"truncated": True, "text": _bounded_for_model(text, td.max_model_chars)}
        return result
    finally:
        conn.close()
