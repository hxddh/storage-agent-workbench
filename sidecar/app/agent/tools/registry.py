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
import re
import threading
import time
import types
import typing
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from ... import db
from ...s3.scope import check_scope
from ...security.redaction import SecretScrubber, redact, redact_text
from .. import safety

# --- declaration -------------------------------------------------------------------


@dataclass(frozen=True)
class Scope:
    """Which parameters name storage, and whether the call lists objects.
    ``listing`` may be a predicate over the arguments, for a tool that lists
    only in some modes (a configuration review that samples objects)."""
    provider: str = "provider_id"
    bucket: str | None = "bucket"
    key: str | None = None
    prefix: str | None = None
    listing: bool | Callable[[dict[str, Any]], bool] = False

    def lists(self, args: dict[str, Any]) -> bool:
        return bool(self.listing(args)) if callable(self.listing) else bool(self.listing)


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
    # Parameters typed as a list or an object: a model that sends one as a string
    # ("security", '["a","b"]', '{"k": "v"}') gets it coerced, not a TypeError.
    shapes: dict[str, str] = field(default_factory=dict)


REGISTRY: dict[str, ToolDef] = {}
MODEL_CHARS_CAP = 60_000

GROUPS: dict[str, str] = {
    "core": "Orientation: accounts, buckets, skills, the estate and the conclusion.",
    "probes": "Endpoint probes: reachability, region, addressing, TLS, latency.",
    "objects": "Objects: listing (keys, versions, multipart uploads) and one object's metadata, preview and read tests.",
    "config": "Bucket configuration: the review per aspect, rule detail, performance profile.",
    "account": "Account-wide survey.",
    "files": "Attached files and imported evidence: analyze, aggregate, import.",
    "advice": "Deterministic advice: error triage, storage-class projection.",
}


def _shapes(fn: Callable[..., Any]) -> dict[str, str]:
    try:
        hints = typing.get_type_hints(fn)
    except Exception:  # noqa: BLE001 — an unresolvable hint just gets no coercion
        return {}
    out: dict[str, str] = {}
    hints.pop("return", None)
    for name, hint in hints.items():
        union = typing.get_origin(hint) in (typing.Union, types.UnionType)
        for opt in (typing.get_args(hint) if union else (hint,)):
            origin = typing.get_origin(opt) or opt
            if origin is list:
                out[name] = "list"
            elif origin is dict:
                out[name] = "dict"
    return out


def coerce_args(td: ToolDef, args: dict[str, Any]) -> dict[str, Any]:
    """A string where a list or object is expected: JSON when it parses as one,
    else (a list) a comma-separated value — ``aspects="security"`` is ``["security"]``."""
    if not td.shapes:
        return args
    out = dict(args)
    for name, shape in td.shapes.items():
        value = out.get(name)
        if not isinstance(value, str):
            continue
        text = value.strip()
        parsed: Any = None
        if text[:1] in ("[", "{"):
            try:
                parsed = json.loads(text)
            except ValueError:
                parsed = None
        if shape == "list":
            if isinstance(parsed, list):
                out[name] = parsed
            elif isinstance(parsed, dict):
                out[name] = [parsed]
            else:
                out[name] = [p.strip() for p in text.split(",") if p.strip()] or None
        else:
            out[name] = parsed if isinstance(parsed, dict) else None
    return out


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
                                      summarize, untrusted, max_model_chars, special, _shapes(fn))
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
    # What one tool output may put in front of the model: the absolute cap, or a
    # quarter of a small window (the runtime sets it from the active model).
    model_chars: int = MODEL_CHARS_CAP
    # Parallel calls run in worker threads: spending from a budget is one step.
    budget_lock: threading.Lock = field(default_factory=threading.Lock)


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
        with self.turn.budget_lock:
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


_PSEUDO_PLURAL = re.compile(r"\b(\d+) ([A-Za-z-]+)\(s\)")
SUMMARY_CHARS = 60


def plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def tidy_summary(text: str) -> str:
    """A tool row's note: one short clause with real plurals ("3 buckets", never "3 bucket(s)")."""
    text = _PSEUDO_PLURAL.sub(lambda m: plural(int(m.group(1)), m.group(2)), str(text or ""))
    text = " ".join(text.replace("(s)", "s").split())
    if len(text) > SUMMARY_CHARS:
        first = re.split(r"(?<=[.;])\s", text)[0]
        text = first if len(first) <= SUMMARY_CHARS else text[:SUMMARY_CHARS - 1].rstrip(" ,;·") + "…"
    return text.rstrip(". ")


def default_summary(result: Any) -> str:
    if isinstance(result, dict):
        if result.get("error"):
            return str(result["error"])
        if result.get("success") is False:
            return str(result.get("error_code") or "failed")
        for key in ("buckets", "objects", "keys", "versions", "uploads", "parts", "groups", "findings", "rows"):
            if isinstance(result.get(key), list):
                return plural(len(result[key]), key[:-1])
        if result.get("summary") and isinstance(result["summary"], str):
            return result["summary"]
        return "done"
    if isinstance(result, str):
        return result
    return "done"


def _ok(result: Any) -> bool:
    return not (isinstance(result, dict) and (result.get("success") is False or "error" in result))


def _target(args: dict[str, Any]) -> str:
    bucket, key = args.get("bucket"), args.get("key")
    if bucket and key:
        return f"{bucket}/{key}"
    if not (bucket or args.get("name") or args.get("dataset_id")) and args.get("provider_id"):
        return _account_name(str(args["provider_id"]))
    return str(bucket or args.get("name") or args.get("dataset_id") or "")[:200]


def _account_name(provider_id: str) -> str:
    """A storage account reads as its name, not its opaque id."""
    try:
        conn = db.connect()
        try:
            row = conn.execute("SELECT name FROM cloud_providers WHERE id = ?", (provider_id,)).fetchone()
        finally:
            conn.close()
    except Exception:  # noqa: BLE001
        row = None
    return str(row["name"] if row else provider_id)[:200]


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


def _account_count() -> int:
    conn = db.connect()
    try:
        return int(conn.execute("SELECT COUNT(*) AS n FROM cloud_providers").fetchone()["n"])
    finally:
        conn.close()


def with_default_provider(td: ToolDef, args: dict[str, Any]) -> dict[str, Any]:
    """A storage tool called without an account uses the only one configured.
    With several (or none), the call is left as is and the scope check refuses it."""
    if td.scope is None or args.get(td.scope.provider):
        return args
    conn = db.connect()
    try:
        rows = conn.execute("SELECT id FROM cloud_providers LIMIT 2").fetchall()
    finally:
        conn.close()
    return {**args, td.scope.provider: rows[0]["id"]} if len(rows) == 1 else args


def scope_denial(td: ToolDef, args: dict[str, Any], *, providers: str = "configured_providers") -> str | None:
    """None when the call is in scope, else why not. ``providers`` names where
    the caller finds account ids (the MCP bridge: its list_providers tool)."""
    if td.scope is None:
        return None
    provider_id = args.get(td.scope.provider)
    if not provider_id:
        return (f"Several storage accounts are configured: pass provider_id (from {providers})."
                if _account_count() else "No storage account is configured. Add one in Settings › Storage accounts.")
    if not isinstance(provider_id, str):
        return f"provider_id must be a string from {providers}."
    from ...providers import clouds
    conn = db.connect()
    try:
        cloud = clouds.get(conn, provider_id)
    finally:
        conn.close()
    if cloud is None:
        return f"Unknown provider_id {provider_id!r}. Use one from {providers}."
    bucket = args.get(td.scope.bucket) if td.scope.bucket else None
    key = args.get(td.scope.key) if td.scope.key else None
    prefix = args.get(td.scope.prefix) if td.scope.prefix else None
    if bucket is None or bucket == "":
        return None
    return check_scope(cloud.allowed_buckets, cloud.allowed_prefixes, bucket,
                       key=None if key == "" else key, prefix=prefix, listing=td.scope.lists(args))


# --- SDK binding ------------------------------------------------------------------------------


def _parse_args(raw: str) -> dict[str, Any]:
    try:
        value = json.loads(raw or "{}")
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _slim(node: Any) -> Any:
    """A JSON schema without what a model does not need: pydantic ``title``s,
    ``Optional`` spelled as anyOf-with-null, empty defaults; one-line descriptions."""
    if isinstance(node, list):
        return [_slim(x) for x in node]
    if not isinstance(node, dict):
        return node
    out: dict[str, Any] = {}
    for key, value in node.items():
        if key == "title":
            continue  # schema metadata; a PROPERTY named "title" lives under "properties"
        if key in ("properties", "$defs"):
            out[key] = {name: _slim(sub) for name, sub in value.items()}
        elif key == "description" and isinstance(value, str):
            out[key] = " ".join(value.split())
        else:
            out[key] = _slim(value)
    variants = out.get("anyOf")
    if isinstance(variants, list):
        real = [v for v in variants if v != {"type": "null"}]
        if len(real) == 1 and len(real) < len(variants):
            del out["anyOf"]
            out = {**real[0], **out}
    if "default" in out and out["default"] in ("", None, 0, False):
        del out["default"]
    return out


def tool_schema(td: ToolDef) -> tuple[str, dict[str, Any]]:
    """(description, parameters) as the model reads them. Not strict: an
    optional argument stays optional and the body's default applies."""
    from agents.function_schema import function_schema
    schema = function_schema(td.fn, strict_json_schema=False)
    return " ".join((schema.description or td.name).split()), _slim(schema.params_json_schema)


def schema_chars(*, responses: bool) -> int:
    """What the tool definitions cost in every request (characters, as sent)."""
    total = 0
    for td in REGISTRY.values():
        if responses and not td.core:
            continue  # deferred: loaded only when the model searches for it
        desc, params = tool_schema(td)
        total += len(json.dumps({"type": "function", "function": {"name": td.name, "description": desc,
                                                                  "parameters": params}}))
    return total


def build_sdk_tools(*, responses: bool, names: set[str] | None = None) -> list[Any]:
    """FunctionTools for this turn. On the Responses backend non-core tools
    become deferred group namespaces behind hosted tool search; elsewhere every
    tool is sent (Chat Completions has no tool search)."""
    from agents import FunctionTool, ToolGuardrailFunctionOutput, tool_input_guardrail, tool_namespace

    tools_by_group: dict[str, list[Any]] = {}
    for td in REGISTRY.values():
        if names is not None and td.name not in names:
            continue
        description, params = tool_schema(td)

        @tool_input_guardrail(name=f"scope:{td.name}")
        def _scope_guard(data, _td=td):  # type: ignore[no-untyped-def]
            args = with_default_provider(_td, coerce_args(
                _td, _parse_args(getattr(data.context, "tool_arguments", "") or "")))
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
            description=description,
            params_json_schema=params,
            on_invoke_tool=_invoke,
            strict_json_schema=False,
            tool_input_guardrails=[_scope_guard] if td.scope else None,
            timeout_seconds=td.timeout,
            defer_loading=responses and not td.core,
        )
        tools_by_group.setdefault("core" if td.core else td.group, []).append(ft)

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
    raw = _parse_args(raw_args)
    if td.special == "conclusion":
        return turn.recorder.conclusion(call_id, raw)
    raw = coerce_args(td, raw)
    filled = with_default_provider(td, raw)
    args = _clamp(filled, td.bounds)
    # The exact secrets this machine holds are masked from everything the call
    # records or returns — built once per call, never logged.
    scrub = SecretScrubber()
    safe_args = scrub(redact(args))
    if filled is not raw:
        # The account was filled in here, after the guardrail read the raw call:
        # check the scope of what will actually run.
        denial = scope_denial(td, args)
        if denial is not None:
            turn.recorder.tool_refused(call_id, td.name, safe_args, denial)
            return f"Refused: {denial}"
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
    clean = scrub(redact(result))
    ok = _ok(clean)
    summary = tidy_summary(scrub(redact_text((td.summarize or default_summary)(clean))))
    text = clean if isinstance(clean, str) else compact_json(clean)
    text = _bounded_for_model(text, min(td.max_model_chars, turn.model_chars))
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
    scrub = SecretScrubber()
    result = scrub(redact(result))
    store.audit(conn, actor=actor, action=f"tool.{name}", target=_target(args), ok=_ok(result),
                duration_ms=int((time.monotonic() - started) * 1000), detail={"args": scrub(redact(args))})
    return result


class _DetachedRecorder:
    """A recorder for calls made outside a turn (the MCP bridge): nothing to stream."""

    def progress(self, *_a: Any, **_k: Any) -> None:
        return None


def call_direct(name: str, args: dict[str, Any], *, actor: str, allowed: frozenset[str],
                turn: TurnContext | None = None, providers: str = "configured_providers") -> Any:
    """Run one registered tool outside a turn — same scope check, bounds and
    redaction as inside one, audited with its actor. Only ``allowed`` tools.
    ``turn`` carries the budgets across calls (the MCP bridge keeps one per time
    window); without it each call starts a fresh one."""
    from ...core import store
    td = REGISTRY.get(name)
    if td is None or name not in allowed:
        return {"error": f"Unknown tool: {name}"}
    args = _clamp(with_default_provider(td, coerce_args(td, dict(args or {}))), td.bounds)
    denial = scope_denial(td, args, providers=providers)
    conn = db.connect()
    try:
        if denial:
            store.audit(conn, actor=actor, action=f"tool.{name}", target=_target(args), ok=False,
                        detail={"refused": denial})
            return {"error": f"Refused: {denial}"}
        if turn is None:
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
