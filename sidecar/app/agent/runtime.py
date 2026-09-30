"""The Agent runtime (v5): one supervisor, one loop thread, one path per turn.

Submitting work creates a Turn (queued) with its Direction recorded at once,
then the task's worker drains its queue one turn at a time on the runtime's
event loop thread. A turn:

1. resolves the model (no model → the turn fails with a user-actionable note);
2. folds older history into a summary when it approaches the window (portable
   compaction; the Responses backend also compacts server-side mid-turn);
3. runs the Agents SDK loop streamed over the branch history (``ItemsSession``),
   with the registry's tools, steer injection and the SDK's tool-output trimmer
   in the model-input filter chain;
4. streams text as live deltas and closes segments into items; tools record
   themselves; the conclusion is a typed tool;
5. on budget/overflow/transient failure writes the answer from the work so far
   with one tool-less call; Stop ends it between steps and keeps the partial
   answer;
6. after a task's first answer, names the task (one tool-less call; a user
   rename wins).

Restart: turns found ``running`` are stamped ``interrupted`` and continued once
(a ``resume`` turn on the same branch — the model sees the completed calls).
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import threading
from dataclasses import dataclass, field
from typing import Any

from .. import db
from ..core import hub, store
from ..providers import models as model_providers
from ..security.redaction import redact, redact_text
from . import budget, errors, models, prompt, safety, tracing
from .recorder import Recorder
from .session import ItemsSession, fit, input_chars, shrink_outputs, to_input
from .tools import registry

logger = logging.getLogger(__name__)

MAX_TURN_STEPS = 60
MAX_PARALLEL_TOOLS = 6
RESUME_NOTE = ("[The app restarted while you were working on this. Your completed tool calls are above. "
               "Continue from where you stopped; do not repeat calls that already returned.]")
# Budgets are fractions of the INPUT budget (window − max_tokens), in tokens
# estimated at budget.CHARS_PER_TOKEN.
_COMPACT_FRACTION = 0.8   # before a Turn: fold older Turns at this
_COMPACT_TARGET = 0.6     # ... until what is left is under this (no compaction every Turn)
_PRESSURE_FRACTION = 0.85  # inside a Turn: shrink earlier tool outputs at this
_SIDE_STEP_FRACTION = 0.9  # a summary / final-answer request fits in this
_SUMMARY_ALLOWANCE_CHARS = 3_000  # what the summary itself will add back
_KEEP_RECENT_TURNS = 2
_TOOL_OUTPUT_FRACTION = 0.25
_MIN_TOOL_OUTPUT_CHARS = 4_000
_SMALL_WINDOW = 65_536  # below this, older tool outputs are trimmed harder
REPEATED_CALL = "Already called with these arguments; the result is above."
TEXT_TOOL_CALL_CORRECTION = (
    "[Your last message was a tool call written as text, so nothing ran. To use a tool, call it through "
    "the tool-calling interface; otherwise write your answer in plain prose.]")
FINALIZE_FAILED = ("The model could not write an answer from the work so far ({why}). The completed steps "
                   "are above; ask me to continue, or check the model in Settings › Models.")


@dataclass
class _Live:
    turn_id: str
    cancel: threading.Event = field(default_factory=threading.Event)
    steers: list[str] = field(default_factory=list)
    result: Any = None
    recorder: Any = None  # the running turn's Recorder: a steer closes ITS open segment first
    # Messages the model-input filter re-inserts at a stable position on every
    # call of this Turn (steers, a correction). Kept on the Turn, not on one SDK
    # run, so a transport retry re-applies them instead of losing them.
    applied: list[tuple[int, dict[str, Any]]] = field(default_factory=list)
    inject: list[dict[str, Any]] = field(default_factory=list)  # waiting for the next model call
    calls_seen: set[str] = field(default_factory=set)  # name + canonical args of this Turn's calls


class Runtime:
    def __init__(self) -> None:
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._live: dict[str, _Live] = {}
        self._workers: dict[str, asyncio.Task[Any]] = {}
        self._lock = threading.Lock()

    # -- lifecycle ---------------------------------------------------------------------
    def start(self) -> None:
        if self._thread is not None:
            return
        ready = threading.Event()

        def run() -> None:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            self._loop = loop
            ready.set()
            loop.run_forever()

        self._thread = threading.Thread(target=run, name="agent-runtime", daemon=True)
        self._thread.start()
        ready.wait(5)
        try:
            tracing.install()
        except Exception:  # noqa: BLE001 — the SDK may be absent in some test envs
            pass

    def stop_all(self) -> None:
        with self._lock:
            lives = list(self._live.values())
        for live in lives:
            live.cancel.set()
            if live.result is not None:
                self._call_soon(live.result.cancel)

    def _reset_for_tests(self) -> None:
        """Stop what runs and forget it; wait briefly so no turn outlives its test's database."""
        self.stop_all()
        workers = list(self._workers.values())
        if self._loop is not None and workers:
            async def settle() -> None:
                await asyncio.wait(workers, timeout=5)
            try:
                asyncio.run_coroutine_threadsafe(settle(), self._loop).result(6)
            except Exception:  # noqa: BLE001
                pass
        with self._lock:
            self._live.clear()
        self._workers.clear()

    def _call_soon(self, fn: Any, *args: Any) -> None:
        if self._loop is not None:
            self._loop.call_soon_threadsafe(fn, *args)

    def _kick(self, task_id: str) -> None:
        if self._loop is None:
            self.start()
        assert self._loop is not None
        asyncio.run_coroutine_threadsafe(self._ensure_worker(task_id), self._loop)

    async def _ensure_worker(self, task_id: str) -> None:
        worker = self._workers.get(task_id)
        if worker is not None and not worker.done():
            return
        self._workers[task_id] = asyncio.create_task(self._drain(task_id))

    # -- public API (thread-safe; called from request handlers) --------------------------
    def submit(self, conn: Any, task_id: str, direction: str, *, kind: str = "direction",
               parent_turn_id: str | None = None, attachments: list[dict[str, Any]] | None = None,
               resumed_from: str | None = None, note: str | None = None, kick: bool = True) -> dict[str, Any]:
        """Queue a Direction as a new turn and make sure the task's worker runs."""
        turn = store.create_turn(conn, task_id, direction, kind=kind, parent_turn_id=parent_turn_id,
                                 resumed_from=resumed_from)
        self._publish_turn(conn, task_id, turn["id"])
        rec = Recorder(task_id, turn["id"])
        try:
            if kind == "resume":
                rec.notice("resumed", note=note or RESUME_NOTE, resumed_from=resumed_from)
            else:
                rec.user_message(direction, attachments)
        finally:
            rec.close()
        self._publish_state(conn, task_id)
        if kick:
            self._kick(task_id)
        return turn

    def steer(self, conn: Any, task_id: str, text: str) -> dict[str, Any]:
        """Give the running turn a new instruction; with nothing running, it is a new Direction."""
        # Recorded and queued for the loop under the runtime lock: the turn cannot
        # finish in between, so a steer is either read by the model or carried
        # into a follow-up Direction when the turn ends first — never dropped.
        with self._lock:
            live = self._live.get(task_id)
            if live is not None and live.recorder is not None:
                live.recorder.steer(text)  # closes the segment being written, then records the steer
                live.steers.append(redact_text(text))
                return {"steered": True, "turn_id": live.turn_id}
        return {"steered": False, "turn": self.submit(conn, task_id, text)}

    def stop(self, task_id: str) -> bool:
        with self._lock:
            live = self._live.get(task_id)
        if live is None:
            return False
        live.cancel.set()
        if live.result is not None:
            self._call_soon(live.result.cancel)
        return True

    def cancel_queued(self, conn: Any, task_id: str, turn_id: str) -> bool:
        turn = store.get_turn(conn, turn_id)
        if turn is None or turn["task_id"] != task_id:
            return False
        # Only a turn still queued can be withdrawn; the worker claims it the same
        # way, so exactly one of the two wins.
        if not store.transition(conn, turn_id, "queued", "cancelled"):
            return False
        rec = Recorder(task_id, turn_id)
        try:
            rec.notice("cancelled", queued=True)
        finally:
            rec.close()
        # A withdrawn Direction leaves the branch: what was queued after it now
        # follows its parent, so the model never reads the withdrawn text.
        for child in store.reparent_children(conn, turn_id, turn["parent_turn_id"]):
            self._publish_turn(conn, task_id, child)
        self._publish_turn(conn, task_id, turn_id)
        # The head falls back to the cancelled turn's parent — or, for a first
        # Direction, to the newest other branch (none: the task reads empty).
        task = store.get_task(conn, task_id)
        if task and task["head_turn_id"] == turn_id:
            if turn["parent_turn_id"]:
                store.set_head(conn, task_id, turn["parent_turn_id"])
            else:
                other = conn.execute("SELECT id FROM turns WHERE task_id = ? AND parent_turn_id IS NULL AND id != ? "
                                     "AND status != 'cancelled' ORDER BY created_at DESC, rowid DESC LIMIT 1",
                                     (task_id, turn_id)).fetchone()
                if other:
                    store.set_head(conn, task_id, store.leaf_of(conn, task_id, other["id"]))
        self._publish_state(conn, task_id)
        return True

    def is_running(self, task_id: str) -> bool:
        with self._lock:
            return task_id in self._live

    def _publish_turn(self, conn: Any, task_id: str, turn_id: str) -> None:
        t = store.get_turn(conn, turn_id)
        if t is not None:
            hub.turn(task_id, store.turn_public(t))

    def _publish_state(self, conn: Any, task_id: str) -> None:
        hub.state(task_id, store.state_payload(conn, task_id))

    # -- worker ------------------------------------------------------------------------------
    async def _drain(self, task_id: str) -> None:
        while True:
            conn = db.connect()
            try:
                # The oldest queued turn whose parent is not itself still waiting:
                # a continuation runs before the Directions queued after it.
                row = conn.execute(
                    "SELECT t.id FROM turns t LEFT JOIN turns p ON p.id = t.parent_turn_id "
                    "WHERE t.task_id = ? AND t.status = 'queued' "
                    "AND (p.id IS NULL OR p.status NOT IN ('queued', 'running')) "
                    "ORDER BY t.created_at, t.rowid LIMIT 1", (task_id,)).fetchone()
            finally:
                conn.close()
            if row is None:
                return
            try:
                await self._run_turn(task_id, row["id"])
            except Exception:  # noqa: BLE001 — a turn's failure is recorded inside
                logger.exception("turn crashed")

    async def _run_turn(self, task_id: str, turn_id: str) -> None:
        conn = db.connect()
        rec = Recorder(task_id, turn_id)
        live = _Live(turn_id, recorder=rec)
        with self._lock:
            self._live[task_id] = live
        clients: list[Any] = []
        status, error = "completed", None
        usage: dict[str, Any] | None = None
        if not store.transition(conn, turn_id, "queued", "running"):
            # Withdrawn between the pick and the claim: nothing runs.
            with self._lock:
                self._live.pop(task_id, None)
            rec.close()
            conn.close()
            return
        carried: list[str] = []
        try:
            self._publish_turn(conn, task_id, turn_id)
            rec.notice("started")
            self._publish_state(conn, task_id)
            try:
                creds = model_providers.credentials(conn)
            except model_providers.AgentUnavailable as exc:
                status, error = "failed", str(exc)
                rec._append("error", {"message": str(exc), "action": "settings"})
                return
            await self._maybe_compact(conn, task_id, turn_id, creds, rec, clients)
            outcome = await self._stream_turn(conn, task_id, turn_id, creds, rec, live, clients)
            if outcome.get("status") == "retry_http":
                # The websocket was refused before anything streamed: the same Turn
                # runs again over HTTP (the endpoint is remembered in NO_WEBSOCKET).
                # Steers the first attempt drained stay on `live.applied`.
                outcome = await self._stream_turn(conn, task_id, turn_id, creds, rec, live, clients)
                if outcome.get("status") == "retry_http":
                    outcome = {"status": "failed", "error": outcome.get("error"), "usage": outcome.get("usage")}
            if (outcome.get("status") == "completed" and not outcome.get("finalized")
                    and not live.cancel.is_set() and looks_like_text_tool_call(rec.last_message)):
                # A small model wrote its tool call as text: nothing ran. Say so once.
                rec.notice("reprompted", reason="text_tool_call")
                live.inject.append({"role": "user", "content": TEXT_TOOL_CALL_CORRECTION})
                again = await self._stream_turn(conn, task_id, turn_id, creds, rec, live, clients)
                again["usage"] = _add_usage(outcome.get("usage"), again.get("usage"))
                outcome = again if again.get("status") != "retry_http" else outcome
            status, error, usage = outcome["status"], outcome.get("error"), outcome.get("usage")
        except Exception as exc:  # noqa: BLE001
            status, error = "failed", errors.user_message(exc)
            rec._append("error", {"message": error})
        finally:
            rec.close_segment()
            with self._lock:
                self._live.pop(task_id, None)
                carried, live.steers[:] = list(live.steers), []
            await models.close_clients(clients)
            store.set_turn_status(conn, turn_id, status, error=error, usage=usage)
            store.touch_task(conn, task_id)
            conn.commit()
            rec.notice(status, **({"error": error} if error else {}))
            if carried and status == "completed":
                # Steers that arrived after the model's last call: they become the
                # next Direction instead of a steer the model never read.
                rec.notice("carried", steers=len(carried))
            self._publish_turn(conn, task_id, turn_id)
            self._publish_state(conn, task_id)
            rec.close()
            if carried and status == "completed":
                self.submit(conn, task_id, "\n\n".join(carried), parent_turn_id=turn_id)
            conn.close()
        if status == "completed":
            await self._maybe_title(task_id, turn_id)

    async def _stream_turn(self, conn: Any, task_id: str, turn_id: str, creds: dict[str, Any],
                           rec: Recorder, live: _Live, clients: list[Any]) -> dict[str, Any]:
        from agents import Agent, RunConfig, Runner
        from agents.extensions import ToolOutputTrimmer
        from agents.run_error_handlers import RunErrorHandlerResult
        from agents.run_config import ToolExecutionConfig

        responses = models.is_responses(creds)
        model, settings = models.build(creds, clients)
        tools = self._guard_tools(registry.build_sdk_tools(responses=responses), live, rec)
        if responses:
            from agents import ToolSearchTool
            tools.append(ToolSearchTool())
        lang = _setting(conn, "language") or "en"
        agent = Agent(name="Storage Agent", instructions=prompt.instructions_for(conn, responses=responses, lang=lang),
                      tools=tools, model=model, model_settings=settings)
        plan = budget.plan(creds)
        schema_chars = registry.schema_chars(responses=responses)
        # Older Directions' tool outputs shrink to a preview; a small window keeps
        # only the current Direction's outputs whole.
        trimmer = (ToolOutputTrimmer(recent_turns=2, max_output_chars=4000, preview_chars=600)
                   if plan.window >= _SMALL_WINDOW else
                   ToolOutputTrimmer(recent_turns=1, max_output_chars=2000, preview_chars=400))

        def model_input(data: Any) -> Any:
            md = trimmer(data)
            if hasattr(md, "__await__"):
                raise RuntimeError("async trimmer unsupported")  # pragma: no cover
            items = list(md.input)
            if not responses:
                # In-turn pressure (Chat Completions has no server-side compaction):
                # this Turn's earlier tool outputs shrink to previews, oldest first,
                # the latest batch stays whole.
                room = (tokens_budget_chars(plan, _PRESSURE_FRACTION)
                        - len(str(md.instructions or "")) - schema_chars)
                items, _ = shrink_outputs(items, room)
            with self._lock:
                fresh, live.steers[:] = list(live.steers), []
                pending, live.inject[:] = list(live.inject), []
            for text in fresh:
                live.applied.append((len(items), {"role": "user", "content": "[The user steered] " + text}))
            for msg in pending:
                live.applied.append((len(items), msg))
            # Latest position first (and, at one position, the later message first),
            # so every message lands where it was first applied, in order.
            for _, (pos, msg) in sorted(enumerate(live.applied), key=lambda x: (x[1][0], x[0]), reverse=True):
                items.insert(min(pos, len(items)), dict(msg))
            md.input = items
            return md

        turn_ctx = registry.TurnContext(task_id, turn_id, live.cancel, rec, lang=lang,
                                        model_chars=tool_output_chars(plan.window))
        run_config = RunConfig(
            call_model_input_filter=model_input,
            tool_not_found_behavior="return_error_to_model",
            tool_execution=ToolExecutionConfig(max_function_tool_concurrency=MAX_PARALLEL_TOOLS),
            workflow_name="storage-agent turn",
            group_id=task_id,
            trace_metadata={"task_id": task_id, "turn_id": turn_id},
            trace_include_sensitive_data=False,
        )
        # The SDK's own error handlers end a run that ran out of steps (or that the
        # model refused) with an answer instead of an exception.
        finalized: dict[str, Any] = {}

        async def on_max_turns(data: Any) -> Any:
            # The branch history from items carries the steers the model input
            # filter injected (the SDK's run history does not).
            text = await self._final_answer(creds, clients, _history(conn, task_id, turn_id), reason="budget")
            finalized.update(text=text or "", reason="budget", failed=text is None)
            return RunErrorHandlerResult(final_output=text or "", include_in_history=False)

        async def on_refusal(data: Any) -> Any:
            text = safety.clean_message(str(data.error))[:600] or "The model declined to continue with this request."
            finalized.update(text=text, reason="refusal")
            return RunErrorHandlerResult(final_output=text, include_in_history=False)

        # History comes from the item stream through the SDK's Session protocol
        # (read-only: the Recorder is the only writer).
        result = Runner.run_streamed(agent, [], context=turn_ctx, max_turns=MAX_TURN_STEPS, run_config=run_config,
                                     session=ItemsSession(task_id, turn_id),
                                     error_handlers={"max_turns": on_max_turns, "model_refusal": on_refusal})
        live.result = result
        streamed = False
        try:
            async for event in result.stream_events():
                if live.cancel.is_set():
                    result.cancel()
                    break
                etype = getattr(event, "type", "")
                streamed = streamed or etype == "run_item_stream_event"
                if etype == "raw_response_event":
                    data = event.data
                    if getattr(data, "type", "") == "response.output_text.delta":
                        rec.delta(getattr(data, "delta", "") or "")
                elif etype == "run_item_stream_event" and event.name in ("message_output_created", "tool_called"):
                    rec.close_segment()
        except Exception as exc:  # noqa: BLE001
            rec.close_segment()
            if errors.is_parallel_refusal(exc):
                models.NO_PARALLEL.add(models.endpoint_key(creds))
            if errors.is_usage_refusal(exc):
                models.NO_USAGE.add(models.endpoint_key(creds))
            if errors.is_websocket_failure(exc):
                key = models.endpoint_key(creds)
                first_refusal = key not in models.NO_WEBSOCKET
                models.NO_WEBSOCKET.add(key)
                if first_refusal and not streamed and not rec.has_output() and not live.cancel.is_set():
                    return {"status": "retry_http", "error": errors.user_message(exc), "usage": _usage(result)}
            if live.cancel.is_set():
                return {"status": "cancelled", "usage": _usage(result)}
            if errors.recoverable(exc):
                text = await self._final_answer(creds, clients, _history(conn, task_id, turn_id), reason="provider")
                if text is None:
                    return self._finalize_failed(rec, errors.user_message(exc), _usage(result))
                rec.notice("finalized", reason="provider")
                rec._append("agent_message", {"text": text})
                return {"status": "completed", "finalized": True, "usage": _usage(result)}
            return {"status": "failed", "error": errors.user_message(exc), "usage": _usage(result)}
        rec.close_segment()
        if live.cancel.is_set():
            return {"status": "cancelled", "usage": _usage(result)}
        if finalized.get("failed"):
            return self._finalize_failed(rec, "the step budget ran out", _usage(result))
        if finalized:
            rec.notice("finalized", reason=finalized["reason"])
            rec._append("agent_message", {"text": finalized["text"]})
            return {"status": "completed", "finalized": True, "usage": _usage(result)}
        return {"status": "completed", "usage": _usage(result)}

    @staticmethod
    def _finalize_failed(rec: Recorder, why: str, usage: dict[str, Any] | None) -> dict[str, Any]:
        """The fallback answer could not be written either: a clear failure, never a canned success."""
        message = FINALIZE_FAILED.format(why=redact_text(why)[:200].rstrip(". "))
        rec._append("error", {"message": message})
        return {"status": "failed", "error": message, "usage": usage}

    def _guard_tools(self, tools: list[Any], live: _Live, rec: Recorder) -> list[Any]:
        """Guards for small models, around every tool of this Turn:
        arguments that are not a JSON object are answered without running; a
        string where the schema wants a list (or a number) is coerced; a call
        identical to one this Turn already made returns a pointer to its result
        instead of running again. Each is recorded like any other call."""
        from agents import FunctionTool

        for ft in tools:
            if not isinstance(ft, FunctionTool):
                continue
            inner = ft.on_invoke_tool
            schema = ft.params_json_schema or {}

            async def guarded(tool_ctx: Any, raw_args: str, _inner=inner, _schema=schema,
                              _name=ft.name) -> Any:
                call_id = getattr(tool_ctx, "tool_call_id", None) or f"call-{id(tool_ctx)}"
                args = parse_tool_args(raw_args)
                if args is None:
                    rec.tool_skipped(call_id, _name, {}, "", ok=False, summary="arguments were not valid JSON",
                                     model_text=("Not run: the arguments were not a valid JSON object. Call "
                                                 f"{_name} again with a JSON object that matches its schema."))
                    return ("Not run: the arguments were not a valid JSON object. Call "
                            f"{_name} again with a JSON object that matches its schema.")
                args = coerce_args(args, _schema)
                key = _name + "\0" + json.dumps(args, sort_keys=True, separators=(",", ":"), default=str)
                with self._lock:
                    repeated = key in live.calls_seen
                    live.calls_seen.add(key)
                if repeated:
                    safe = redact(args)
                    rec.tool_skipped(call_id, _name, safe, registry_target(safe), ok=True,
                                     summary="repeated call, not run", model_text=REPEATED_CALL)
                    return REPEATED_CALL
                try:
                    return await _inner(tool_ctx, json.dumps(args))
                except BaseException:
                    with self._lock:
                        live.calls_seen.discard(key)  # stopped or timed out: a retry may run
                    raise

            ft.on_invoke_tool = guarded
        return tools

    async def _final_answer(self, creds: dict[str, Any], clients: list[Any], history: list[Any], *,
                            reason: str) -> str | None:
        """The answer the work so far supports, written with no tools, from the
        history fitted to the window this step protects. None when even that failed."""
        from agents import Agent, Runner
        model, settings = models.build(creds, clients, tools_allowed=False)
        agent = Agent(name="Storage Agent", instructions=prompt.FINALIZE_INSTRUCTIONS, model=model,
                      model_settings=settings)
        ask = {"role": "user", "content": (
            "[Your step budget ran out]" if reason == "budget" else "[The model call failed mid-work]")
            + " Write the best answer the work above supports, and say what remains."}
        room = side_step_chars(budget.plan(creds), prompt.FINALIZE_INSTRUCTIONS) - len(ask["content"])
        try:
            out = await Runner.run(agent, fit(list(history), room) + [ask], max_turns=1)
            text = safety.clean_message(str(out.final_output or ""))
        except Exception as exc:  # noqa: BLE001
            text = ""
            logger.info("finalize failed: %s", redact_text(str(exc))[:200])
        return text or None

    async def _maybe_compact(self, conn: Any, task_id: str, turn_id: str, creds: dict[str, Any],
                             rec: Recorder, clients: list[Any]) -> None:
        """Fold older turns into one summary item when the request nears the input
        budget: the history PLUS the fixed prefix every request carries
        (instructions and tool definitions — on a small local model, most of the
        window). The two latest earlier Turns stay verbatim when that is enough;
        otherwise more fold, down to every earlier Turn (the current Direction stays)."""
        chain = store.branch(conn, task_id, turn_id)
        if len(chain) < 2:
            return
        plan = budget.plan(creds)
        responses = models.is_responses(creds)
        lang = _setting(conn, "language") or "en"
        prefix = (len(prompt.instructions_for(conn, responses=responses, lang=lang))
                  + registry.schema_chars(responses=responses))
        if not needs_compaction(input_chars(_history(conn, task_id, turn_id)), prefix, plan.input_tokens):
            return
        earlier = chain[:-1]
        target = tokens_budget_chars(plan, _COMPACT_TARGET) - prefix - _SUMMARY_ALLOWANCE_CHARS
        older: list[str] = []
        for keep in range(min(_KEEP_RECENT_TURNS, len(earlier) - 1), -1, -1):
            older = [t["id"] for t in earlier[:len(earlier) - keep]]
            kept = to_input(store.items_for_turns(conn, [t["id"] for t in chain[len(older):]]))
            if input_chars(kept) <= target:
                break
        from agents import Agent, Runner
        model, settings = models.build(creds, clients, tools_allowed=False)
        agent = Agent(name="Summarizer", model=model, model_settings=settings, instructions=prompt.COMPACT_INSTRUCTIONS)
        ask = {"role": "user", "content": "Write the summary now."}
        room = side_step_chars(plan, prompt.COMPACT_INSTRUCTIONS) - len(ask["content"])
        items = fit(to_input(store.items_for_turns(conn, older)), room)
        try:
            out = await Runner.run(agent, items + [ask], max_turns=1)
            summary = safety.clean_message(str(out.final_output or ""))[:8000]
        except Exception:  # noqa: BLE001 — compaction is an optimization, never a failure
            return
        if summary:
            # Recorded on the oldest kept turn (the current one when every earlier
            # turn folded); history reads it first and skips the folded turns.
            item = store.append_item(conn, task_id, chain[len(older)]["id"], "compaction",
                                     {"summary": summary, "turns_folded": len(older), "folded": older})
            hub.item(task_id, item)
            rec.notice("compacted", turns_folded=len(older))

    async def _maybe_title(self, task_id: str, turn_id: str) -> None:
        conn = db.connect()
        try:
            task = store.get_task(conn, task_id)
            if task is None or task["title_source"] != "seed":
                return
            items = store.items_for_turns(conn, [turn_id])
            direction = next((i["payload"]["text"] for i in items if i["type"] == "user_message"), "")
            answer = next((i["payload"]["text"] for i in reversed(items) if i["type"] == "agent_message"), "")
            if not answer:
                return
            creds = model_providers.credentials(conn)
            clients: list[Any] = []
            try:
                from agents import Agent, Runner
                model, settings = models.build(creds, clients, tools_allowed=False)
                agent = Agent(name="Titler", model=model, model_settings=settings, instructions=prompt.TITLE_INSTRUCTIONS)
                out = await Runner.run(agent, f"Request: {direction[:600]}\n\nResult: {answer[:1200]}",
                                       max_turns=1)
                title = safety.clean_message(str(out.final_output or "")).strip().strip('"').splitlines()
            finally:
                await models.close_clients(clients)
            if title and title[0].strip():
                if store.rename_task(conn, task_id, " ".join(title[0].split()[:8])[:120], source="agent"):
                    rec = Recorder(task_id, turn_id)
                    try:
                        rec.notice("titled", title=store.get_task(conn, task_id)["title"])
                    finally:
                        rec.close()
                    hub.publish_global("task", {"task_id": task_id, "title": store.get_task(conn, task_id)["title"]})
        except Exception:  # noqa: BLE001 — the title step never fails a turn
            pass
        finally:
            conn.close()

    # -- recovery ----------------------------------------------------------------------------
    def recover(self) -> int:
        """Stamp turns left running by a previous process and continue each once."""
        conn = db.connect()
        count = 0
        try:
            rows = conn.execute("SELECT * FROM turns WHERE status = 'running'").fetchall()
            for r in rows:
                store.set_turn_status(conn, r["id"], "interrupted")
                rec = Recorder(r["task_id"], r["id"])
                try:
                    rec.close_segment()
                    rec.notice("interrupted")
                finally:
                    rec.close()
                count += 1
                if r["kind"] == "resume":
                    continue  # one continuation per chain: never a crash loop
                try:
                    model_providers.credentials(conn)
                except model_providers.AgentUnavailable:
                    continue  # the Task offers Resume once a model exists
                queued = [c["id"] for c in conn.execute(
                    "SELECT id FROM turns WHERE parent_turn_id = ? AND status = 'queued'", (r["id"],)).fetchall()]
                # Not started yet: the queued follow-ups are re-parented first
                # (the loop below starts every task with queued turns).
                task = store.get_task(conn, r["task_id"])
                was_head = task["head_turn_id"] if task else None
                resume = self.submit(conn, r["task_id"], r["direction"], kind="resume", parent_turn_id=r["id"],
                                     resumed_from=r["id"], kick=False)
                # Directions queued after the interrupted turn now follow its
                # continuation (and wait for it).
                for cid in queued:
                    conn.execute("UPDATE turns SET parent_turn_id = ? WHERE id = ?", (resume["id"], cid))
                conn.commit()
                if was_head in (r["id"], *queued):
                    # The reader was on this branch: follow it to its tip.
                    store.set_head(conn, r["task_id"], store.leaf_of(conn, r["task_id"], resume["id"]))
                elif was_head:
                    store.set_head(conn, r["task_id"], was_head)  # a reader on another version stays there
            for r in conn.execute("SELECT DISTINCT task_id FROM turns WHERE status = 'queued'").fetchall():
                self._kick(r["task_id"])
        finally:
            conn.close()
        return count

    def resume(self, conn: Any, task_id: str, turn_id: str) -> dict[str, Any] | None:
        turn = store.get_turn(conn, turn_id)
        if turn is None or turn["task_id"] != task_id or turn["status"] not in ("interrupted", "failed", "cancelled"):
            return None
        if turn["status"] == "cancelled" and not turn.get("started_at"):
            return None  # a withdrawn Direction never ran: there is nothing to continue
        note = RESUME_NOTE if turn["status"] == "interrupted" else (
            "[Continue this work from where it stopped; do not repeat calls that already returned.]")
        return self.submit(conn, task_id, turn["direction"], kind="resume", parent_turn_id=turn_id,
                           resumed_from=turn_id, note=note)


def tokens_budget_chars(plan: budget.Plan, fraction: float) -> int:
    """``fraction`` of the input budget (window − max_tokens), in characters."""
    return budget.tokens_to_chars(plan.input_tokens * fraction)


def side_step_chars(plan: budget.Plan, instructions: str) -> int:
    """What a tool-less side step's history may take: its request fits the window it protects."""
    return max(1_000, tokens_budget_chars(plan, _SIDE_STEP_FRACTION) - len(instructions))


def needs_compaction(history_chars: int, prefix_chars: int, input_tokens: int) -> bool:
    """Whether a request (fixed prefix + history, in chars) reaches the compaction
    threshold of the input budget (window − max_tokens, in tokens)."""
    return budget.est_tokens(prefix_chars + history_chars) >= input_tokens * _COMPACT_FRACTION


def tool_output_chars(window_tokens: int) -> int:
    """What one tool output may put in front of the model: a quarter of the
    window, never above the absolute cap (60 000) nor below a workable floor."""
    return max(_MIN_TOOL_OUTPUT_CHARS,
               min(registry.MODEL_CHARS_CAP, budget.tokens_to_chars(window_tokens * _TOOL_OUTPUT_FRACTION)))


def parse_tool_args(raw: str | None) -> dict[str, Any] | None:
    """A call's arguments as an object; None when they are not JSON (an empty
    string is no arguments). A small model's code fence around them is forgiven."""
    text = (raw or "").strip()
    if not text:
        return {}
    if text.startswith("```"):
        text = text.strip("`").removeprefix("json").strip()
    try:
        value = json.loads(text)
    except (TypeError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def coerce_args(args: dict[str, Any], schema: dict[str, Any]) -> dict[str, Any]:
    """Coerce the shapes a small model gets wrong to what the schema declares:
    a string where a list is expected (``"security"``, ``"a,b"``, ``'["a"]'``),
    a number or boolean written as a string. Anything else passes unchanged."""
    props = schema.get("properties") or {}
    out = dict(args)
    for name, value in args.items():
        kind = (props.get(name) or {}).get("type")
        if kind == "array" and isinstance(value, str):
            text = value.strip()
            parsed: Any = None
            if text.startswith("["):
                try:
                    parsed = json.loads(text)
                except ValueError:
                    parsed = None
            out[name] = parsed if isinstance(parsed, list) else [p.strip() for p in text.split(",") if p.strip()]
        elif kind == "integer" and isinstance(value, str) and value.strip().lstrip("-").isdigit():
            out[name] = int(value.strip())
        elif kind == "boolean" and isinstance(value, str) and value.strip().lower() in ("true", "false"):
            out[name] = value.strip().lower() == "true"
    return out


def registry_target(args: dict[str, Any]) -> str:
    bucket, key = args.get("bucket"), args.get("key")
    return str(f"{bucket}/{key}" if bucket and key else bucket or args.get("provider_id") or "")[:200]


_TOOL_TAGS = re.compile(r"<\|?/?(tool_call|function_call|tool_calls)\|?>|\[TOOL_CALLS\]", re.I)


def looks_like_text_tool_call(text: str) -> bool:
    """Whether a final message is a tool call written as text (a small model
    that did not use the tool interface): ``<tool_call>`` tags, or a message that
    is nothing but JSON naming a known tool with its arguments."""
    body = (text or "").strip()
    if not body:
        return False
    if _TOOL_TAGS.search(body):
        return True
    if body.startswith("```"):
        body = body.strip("`").strip()
        body = body[4:].strip() if body.lower().startswith("json") else body
    if not body.startswith(("{", "[")):
        return False
    try:
        value = json.loads(body)
    except ValueError:
        return False
    calls = value if isinstance(value, list) else [value]
    for c in calls:
        if not isinstance(c, dict):
            return False
        fn = c.get("function") if isinstance(c.get("function"), dict) else c
        if not (isinstance(fn.get("name"), str) and fn["name"] in registry.REGISTRY
                and ("arguments" in fn or "parameters" in fn)):
            return False
    return bool(calls)


def _add_usage(a: dict[str, Any] | None, b: dict[str, Any] | None) -> dict[str, Any] | None:
    if not a or not b:
        return a or b
    return {k: (a.get(k) or 0) + (b.get(k) or 0) for k in {*a, *b}}


def _history(conn: Any, task_id: str, turn_id: str) -> list[dict[str, Any]]:
    chain = store.branch(conn, task_id, turn_id)
    return to_input(store.items_for_turns(conn, [t["id"] for t in chain]))


def _usage(result: Any) -> dict[str, Any] | None:
    try:
        u = result.context_wrapper.usage
        return {"requests": u.requests, "input_tokens": u.input_tokens, "output_tokens": u.output_tokens,
                "cached_tokens": getattr(u.input_tokens_details, "cached_tokens", 0) or 0,
                "reasoning_tokens": getattr(u.output_tokens_details, "reasoning_tokens", 0) or 0}
    except Exception:  # noqa: BLE001
        return None


def _setting(conn: Any, key: str) -> str | None:
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


RUNTIME = Runtime()
