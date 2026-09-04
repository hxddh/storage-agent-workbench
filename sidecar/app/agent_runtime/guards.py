"""Tool wrappers: gating, timeouts, untrusted envelope, output budget, compaction."""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

from . import session_action_tools
from . import model_budget
from . import session_analysis_tools
from . import session_memory_tools
from . import session_tools

from .limits import (_NO_TIMEOUT_TOOLS, _BUDGET_EXEMPT_TOOLS, _COMPACT_AFTER_STEPS, _COMPACT_KEEP_HEAD, _COMPACT_MIN_CHARS, _CORE_TOOLS, _DEDUPE_EXEMPT_TOOLS, _ENVELOPE_EXEMPT_TOOLS, _GROUP_OF_TOOL, _SLOW_TOOLS, _SLOW_TOOL_TIMEOUT_S, _TOOL_BUDGET_EXHAUSTED, _TOOL_GROUPS, _TOOL_OUTPUT_TOO_LARGE, _TOOL_TIMEOUT_S, _UNTRUSTED_CLOSE, _UNTRUSTED_OPEN)

def _build_tools(conn: Any, function_tool: Callable, activity: list[dict[str, Any]] | None,
                 session_id: str | None, turn_id: str | None = None,
                 cancel_event: Any = None, model: str | None = None,
                 explicit_window: int | None = None,
                 unlocked: set[str] | None = None) -> list[Any]:
    """The agent's full read-only toolset (no autonomy toggle — always available)."""
    if conn is None:
        return []
    tools = session_tools.build(conn, function_tool, activity, session_id=session_id,
                                unlocked=unlocked)
    tools += session_action_tools.build(conn, function_tool, activity, session_id, turn_id,
                                        cancel_event=cancel_event, model=model,
                                        explicit_window=explicit_window)
    # Working-memory tools are always available (recording is cloud-read-only).
    tools += session_memory_tools.build(conn, function_tool, session_id, activity)
    # Uploaded-file analysis is always available (local, read-only, sanitized) so
    # the agent can analyze an attached log/inventory itself and answer inline.
    tools += session_analysis_tools.build(conn, function_tool, session_id, activity)
    from . import session_optimization_tools
    tools += session_optimization_tools.build(conn, function_tool, session_id, activity)
    # The ONE data-moving tool: plans, then pauses the execution for the user's
    # approval inside the turn (v1.11).
    from . import gated_tools
    tools += gated_tools.build(conn, function_tool, activity, session_id, turn_id,
                               cancel_event=cancel_event)
    # The plan the model owns (v1.12): a checklist the runtime records.
    from . import plan_tools
    tools += plan_tools.build(function_tool, activity)
    return tools


def _build_load_tools(function_tool: Callable, unlocked: set[str],
                      activity: list[dict[str, Any]] | None) -> Any:
    """The one tool that opens a gated group. Always exposed, always cheap.

    It mutates the very set every gate closes over, and the SDK re-reads
    ``is_enabled`` on the next step — so the group is usable immediately, in the
    same turn, with no agent rebuild.

    An unknown group name is answered with the valid list rather than an error:
    the agent asked a reasonable question and should be able to correct itself in
    one step instead of burning the turn on a failure it cannot parse."""

    @function_tool
    def load_tools(group: str) -> str:
        """Unlock one GROUP of specialist read-only tools for this turn, when the question needs it. The group's tools become callable on your very next step. Groups (see the catalog in your instructions): object_forensics, endpoint_probes, storage_pileup, bucket_config, uploaded_files, account_wide. Unlock only what the question actually needs — an unused group costs tokens on every later step. Args: group."""
        name = (group or "").strip()
        if name not in _TOOL_GROUPS:
            return json.dumps({
                "error": "Unknown tool group.",
                "valid_groups": sorted(_TOOL_GROUPS),
            })
        already = name in unlocked
        unlocked.add(name)
        if activity is not None:
            activity.append({"tool": "load_tools", "target": name,
                             "result": "already available" if already else "unlocked",
                             "args": {"group": name}, "ok": True, "status": "completed"})
        return json.dumps({
            "unlocked_group": name,
            "tools_now_available": sorted(_TOOL_GROUPS[name][1]),
            "note": "These are callable from your next step onward.",
        })

    return load_tools


def _neutralize_envelope_markers(text: str) -> str:
    """Defang any literal envelope marker inside a tool payload.

    Without this, content could contain the closing marker verbatim, "close"
    the envelope early, and place attacker text OUTSIDE the untrusted region."""
    for m in (_UNTRUSTED_OPEN, _UNTRUSTED_CLOSE):
        if m in text:
            text = text.replace(m, m.replace("<<", "< <", 1))
    return text


def _strip_schema_titles(tools: list[Any]) -> int:
    """Drop Pydantic's ``title`` keys from every tool's parameter schema.

    The SDK derives each schema from the function signature, and Pydantic stamps
    a ``title`` on every property plus the schema itself — ``"title": "Provider
    Id"`` sitting next to ``"provider_id"``. It restates the property name in
    title case and tells the model nothing the key does not already say.

    Measured across the 42 tools: 3,559 of 11,765 parameter-schema chars, **30%**
    — re-sent on every step of every turn. Titles are not part of the strict
    function-calling contract (``additionalProperties``/``required`` are, and
    both are left alone), so this is a pure subtraction.

    Returns the chars removed, so the saving is a measured number rather than a
    claim. Mutates in place; a frozen or foreign tool object is skipped.

    The walk is SCHEMA-AWARE, not a blind recursive key delete. ``title`` is a
    JSON-Schema keyword in one position and an ordinary property NAME in another
    — ``record_finding(title, severity)`` has a parameter called exactly that.
    Deleting keys named ``title`` everywhere removed that parameter while
    ``required`` still demanded it, which would have made the tool uncallable.
    So only a schema node's OWN ``title`` goes, and recursion descends solely
    through the keywords whose values are themselves schemas."""
    removed = 0
    # Keywords whose value is a schema, or a container of schemas.
    _SCHEMA_VALUES = ("items", "additionalProperties", "not", "contains",
                      "if", "then", "else")
    _SCHEMA_MAPS = ("properties", "$defs", "definitions", "patternProperties")
    _SCHEMA_LISTS = ("anyOf", "oneOf", "allOf", "prefixItems")

    def _strip(node: Any) -> Any:
        if not isinstance(node, dict):
            return node
        out = {k: v for k, v in node.items() if k != "title"}
        for key in _SCHEMA_MAPS:
            # Property NAMES are data, never keywords — only their values are
            # schemas, so this is where the `title` parameter survives.
            if isinstance(out.get(key), dict):
                out[key] = {name: _strip(sub) for name, sub in out[key].items()}
        for key in _SCHEMA_LISTS:
            if isinstance(out.get(key), list):
                out[key] = [_strip(sub) for sub in out[key]]
        for key in _SCHEMA_VALUES:
            if isinstance(out.get(key), dict):
                out[key] = _strip(out[key])
        return out

    for t in tools:
        schema = getattr(t, "params_json_schema", None)
        if not isinstance(schema, dict):
            continue
        lean = _strip(schema)
        try:
            t.params_json_schema = lean
        except Exception:  # noqa: BLE001 — frozen/foreign tool object: skip
            continue
        removed += len(json.dumps(schema, separators=(",", ":"))) - \
            len(json.dumps(lean, separators=(",", ":")))
    return removed


def _json_consumed_digest(body: str) -> str | None:
    """Structured remainder of a consumed JSON tool result.

    The first 800 characters of a listing are usually the start of a keys array
    — the least useful part once the agent has already used the page. Scalars
    (status, counts, truncation flags) plus array lengths are what the next
    step still needs to know the call happened and what it covered.
    """
    try:
        data = json.loads(body)
    except (json.JSONDecodeError, TypeError, ValueError):
        return None
    if not isinstance(data, dict) or not data:
        return None
    digest: dict[str, Any] = {}
    for key, value in data.items():
        name = str(key)[:64]
        if isinstance(value, bool) or value is None or isinstance(value, (int, float)):
            digest[name] = value
        elif isinstance(value, str):
            digest[name] = value if len(value) <= 200 else value[:200] + "…"
        elif isinstance(value, list):
            digest[f"{name}_count"] = len(value)
        elif isinstance(value, dict):
            nested: dict[str, Any] = {}
            for inner_k, inner_v in list(value.items())[:12]:
                if isinstance(inner_v, (str, int, float, bool)) or inner_v is None:
                    nested[str(inner_k)[:64]] = (
                        inner_v if not isinstance(inner_v, str) or len(inner_v) <= 120
                        else inner_v[:120] + "…"
                    )
            if nested:
                digest[name] = nested
    if not digest:
        return None
    return json.dumps(digest, separators=(",", ":"), ensure_ascii=False)


def _compact_output_text(text: str) -> str:
    """One consumed tool result, reduced to a digest plus an explicit accounting.

    JSON payloads keep scalars and array lengths (not the start of a keys dump).
    Non-JSON keeps the head of the payload. The envelope is preserved when it
    was there: the remainder is still third-party data and must keep saying so
    (SEC4), while the accounting line is runtime text ABOUT the data and sits
    outside it — the same inside/outside split the budget notes use.
    """
    body, open_m, close_m = text, "", ""
    if text.startswith(_UNTRUSTED_OPEN) and text.rstrip().endswith(_UNTRUSTED_CLOSE):
        open_m, close_m = _UNTRUSTED_OPEN, _UNTRUSTED_CLOSE
        body = text[len(_UNTRUSTED_OPEN):text.rstrip().rfind(_UNTRUSTED_CLOSE)].strip("\n")
    if len(body) <= _COMPACT_KEEP_HEAD:
        return text
    digest = _json_consumed_digest(body)
    remainder = digest if digest and len(digest) < len(body) else body[:_COMPACT_KEEP_HEAD]
    dropped = max(0, len(body) - len(remainder))
    kept = f"{open_m}\n{remainder}\n{close_m}" if open_m else remainder
    # Never a silent cut. The model must be able to tell a compacted listing from
    # a complete one, or it will report a partial page as the whole bucket.
    return (f"{kept}\n[COMPACTED: this result is {_COMPACT_AFTER_STEPS}+ steps old; "
            f"{dropped} characters of it were dropped to make room. You already "
            f"used it. If you need the full result again, call the tool again "
            f"with the same arguments.]")


def _compact_consumed_outputs(items: list[Any]) -> tuple[list[Any], int]:
    """Shrink tool results the agent has already had for several steps.

    Returns (new_items, chars_reclaimed). Only ``function_call_output`` items are
    touched, and only those that are both old enough and big enough — every other
    item, including the user's question, the agent's own messages and the tool
    CALLS themselves, is passed through untouched so the transcript the model
    sees stays structurally identical.

    Interaction with v0.54.0's in-turn dedupe, stated rather than discovered
    later: a repeated identical call already returns a pointer instead of
    re-running, and that pointer's summary was captured at call time, so
    compaction does not degrade it. What compaction does change is that the
    pointer's "its result is above in the conversation" is now only partly true —
    the wording was corrected to match.
    """
    if not items:
        return items, 0
    # Index the tool results so "age" is measured in RESULTS, not in raw items:
    # a step is a result, and interleaved assistant/tool-call items would
    # otherwise make an output look older than it is.
    positions = [i for i, it in enumerate(items)
                 if isinstance(it, dict) and it.get("type") == "function_call_output"]
    if len(positions) <= _COMPACT_AFTER_STEPS:
        return items, 0
    compactable = set(positions[:-_COMPACT_AFTER_STEPS]) if _COMPACT_AFTER_STEPS else set(positions)
    out: list[Any] = []
    reclaimed = 0
    for i, it in enumerate(items):
        if i not in compactable:
            out.append(it)
            continue
        text = it.get("output")
        if not isinstance(text, str) or len(text) < _COMPACT_MIN_CHARS:
            out.append(it)
            continue
        shrunk = _compact_output_text(text)
        if len(shrunk) >= len(text):
            out.append(it)
            continue
        reclaimed += len(text) - len(shrunk)
        # Copy: the SDK owns this list and may reuse the items elsewhere.
        out.append({**it, "output": shrunk})
    return out, reclaimed


def _make_tool_not_found_formatter(unlocked: set[str]) -> Any:
    """Turn "tool not found" into "that tool is in group X — unlock it".

    With progressive disclosure a not-found tool is almost never a hallucinated
    name: it is a REAL tool of this product sitting behind a gate the agent has
    not opened. `_GROUP_OF_TOOL` knows exactly which gate, so the correction can
    name it and the agent recovers in one step instead of guessing.

    Three cases, kept distinct because they need different answers:

    - a known tool in a locked group  → name the group and the `load_tools` call;
    - a known tool in an OPEN group   → the gate is not the problem, so say so
      rather than sending the agent to re-unlock something already unlocked
      (that would loop);
    - anything else                   → fall through to the SDK's own message by
      returning None; inventing a group for a name we do not recognise would be
      a confident lie.

    Never raises: the formatter runs inside the SDK's error path, and an
    exception here would replace a recoverable mistake with an unrecoverable one.
    """
    def _fmt(args: Any) -> str | None:
        try:
            if getattr(args, "kind", None) != "tool_not_found":
                return None
            name = str(getattr(args, "tool_name", "") or "")
            group = _GROUP_OF_TOOL.get(name)
            if not group:
                return None
            if group in unlocked:
                return (
                    f"`{name}` is not available under that exact name. Its group "
                    f"'{group}' is already unlocked, so do NOT call load_tools "
                    "again — check the tool list you were given and use the "
                    "correct name."
                )
            return (
                f"`{name}` exists but its tool group is not open yet. Call "
                f"load_tools(group=\"{group}\") first, then call `{name}`. "
                "Nothing you have already gathered is lost."
            )
        except Exception:  # noqa: BLE001 — never break the SDK's error path
            return None
    return _fmt


def _make_input_filter(stats: dict[str, int]) -> Any:
    """The `call_model_input_filter` that applies the compaction per request.

    Never raises: a bookkeeping helper must not be able to fail a turn, so any
    unexpected item shape falls through to the untouched input.
    """
    from agents.run import ModelInputData

    def _filter(data: Any) -> Any:
        try:
            items = list(getattr(data.model_data, "input", None) or [])
            new_items, reclaimed = _compact_consumed_outputs(items)
            if not reclaimed:
                return data.model_data
            stats["compacted_chars"] = stats.get("compacted_chars", 0) + reclaimed
            stats["compacted_calls"] = stats.get("compacted_calls", 0) + 1
            return ModelInputData(input=new_items,
                                  instructions=data.model_data.instructions)
        except Exception:  # noqa: BLE001 — never let an optimization break a turn
            return data.model_data

    return _filter


def _install_tool_timeouts(tools: list[Any]) -> int:
    """Give every tool a wall-clock ceiling. Returns how many were bounded.

    An unbounded tool call is the one failure mode this product is least
    entitled to have: it diagnoses storage endpoints, and an endpoint that
    completes a TCP handshake and then goes silent is a routine finding. Without
    a bound, that endpoint holds the turn open for as long as the socket does.

    A timeout arrives as a tool RESULT (`error_as_result`), so the agent reads it
    as evidence — "this probe never came back" is itself a diagnosis — instead of
    the turn dying on an exception."""
    bounded = 0
    for t in tools:
        name = getattr(t, "name", "")
        if not hasattr(t, "timeout_seconds") or name in _NO_TIMEOUT_TOOLS:
            continue
        try:
            t.timeout_seconds = (_SLOW_TOOL_TIMEOUT_S if name in _SLOW_TOOLS
                                 else _TOOL_TIMEOUT_S)
            t.timeout_behavior = "error_as_result"
        except Exception:  # noqa: BLE001 — frozen/foreign tool object: skip
            continue
        bounded += 1
    return bounded


def _install_tool_gating(tools: list[Any], unlocked: set[str]) -> set[str]:
    """Expose CORE always; gate every other group behind ``unlocked``.

    ``Agent.get_all_tools`` re-evaluates each tool's ``is_enabled`` on EVERY step
    of the loop, so a group the agent unlocks mid-turn is visible on the very
    next request — no agent rebuild, no restart, nothing permanently hidden.

    A tool whose name is in no group is treated as CORE. That default matters:
    a tool added later without a group entry stays visible and merely misses the
    saving, instead of silently disappearing from the agent's repertoire.

    Returns the same ``unlocked`` set the caller passes in — the tools close over
    it, so ``load_tools`` mutating it is what opens the gate."""
    for t in tools:
        name = getattr(t, "name", "")
        group = _GROUP_OF_TOOL.get(name)
        if group is None or name in _CORE_TOOLS:
            continue

        def _gate(_group: str):
            # Bound per tool, not read from the loop variable inside the closure
            # (the v0.54.0 lesson): a late read gives every gate the last group.
            def enabled(_ctx: Any = None, _agent: Any = None) -> bool:
                return _group in unlocked
            return enabled

        try:
            t.is_enabled = _gate(group)
        except Exception:  # noqa: BLE001 — frozen/foreign tool object: skip
            pass
    return unlocked


def _install_untrusted_envelope(tools: list[Any]) -> None:
    """Wrap each data-deriving tool's output in the untrusted-data envelope.

    Installed BEFORE the budget wrapper, so the envelope is the inner layer:
    the budget's own runtime status notes (budget_exhausted / cancelled /
    output_too_large) are agent-runtime instructions TO the model and must stay
    outside the envelope, while every real payload — S3-derived, file-derived,
    run-derived — is marked as data. Only what the MODEL sees changes; audit
    rows and activity cards are recorded inside the tools, before this wrapper.
    Fake tools in tests (plain callables) are left untouched.
    """
    for t in tools:
        orig = getattr(t, "on_invoke_tool", None)
        if orig is None or getattr(t, "name", "") in _ENVELOPE_EXEMPT_TOOLS:
            continue

        def _make(_orig):
            async def wrapped(ctx: Any, args: Any) -> Any:
                out = await _orig(ctx, args)
                text = _neutralize_envelope_markers(str(out or ""))
                return f"{_UNTRUSTED_OPEN}\n{text}\n{_UNTRUSTED_CLOSE}"
            return wrapped

        try:
            t.on_invoke_tool = _make(orig)
        except Exception:  # noqa: BLE001 — frozen/foreign tool object: skip the wrap
            pass


def _live_tokens(ctx: Any) -> int | None:
    """Tokens this turn has spent SO FAR, from the run's live usage.

    The SDK accumulates usage on the run context as each model response lands,
    and that number already includes the re-sent conversation — so summing it is
    the true bill, not an estimate of one. Returns None when the endpoint reports
    no usage at all, which is common on OpenAI-compatible gateways; the caller
    then falls back to the character budget, exactly as before v0.54.0."""
    try:
        usage = getattr(ctx, "usage", None)
        total = int(getattr(usage, "input_tokens", 0) or 0) + \
            int(getattr(usage, "output_tokens", 0) or 0)
    except (TypeError, ValueError, AttributeError):
        return None
    return total if total > 0 else None


def _call_key(tool_name: str, args: Any) -> str:
    """Identity of one tool invocation, for within-turn de-duplication."""
    return f"{tool_name}\u0000{str(args or '')[:2000]}"


def _install_tool_output_budget(tools: list[Any],
                                limit: int | None = None,
                                model: str | None = None,
                                explicit_window: int | None = None,
                                token_limit: int | None = None,
                                explicit_token_budget: int | None = None,
                                cancel_event: Any = None) -> dict[str, int]:
    """Cap the CUMULATIVE characters of tool output handed to the model per turn.

    ``limit`` defaults to the model-elastic budget (``model_budget``) — scaled to
    the active model's context window, floored at ``_MAX_TOOL_OUTPUT_CHARS`` so a
    128k/200k model is unchanged and a 1M model gets a proportionally deeper turn.

    A bound, not a gate: once ``limit`` is spent, every further (non-memory)
    tool call returns a short structured note telling the model to synthesize —
    so a sprawling investigation degrades into an answer instead of blowing the
    provider's context window. Wraps each SDK FunctionTool's ``on_invoke_tool``;
    fake tools in tests (plain callables) are left untouched.
    """
    if limit is None:
        limit = model_budget.tool_output_char_budget(model, explicit_window)
    if token_limit is None:
        token_limit = model_budget.turn_token_budget(model, explicit_window,
                                                     explicit_token_budget)
    spent: dict[str, Any] = {
        "chars": 0, "exhausted": False, "limit": limit,
        # v0.54.0: the bound that is actually denominated in what a turn costs.
        # `tokens` stays None on an endpoint that reports no usage — the char
        # budget above remains the only bound there, and says so.
        "token_limit": token_limit, "tokens": None, "stopped_on": None,
        # Identical (tool, args) pairs a turn repeated. The second call returns a
        # pointer instead of the payload: re-fetching an unchanged read-only
        # result costs the full payload again AND carries it for the rest of the
        # turn, for a byte-identical answer.
        "seen": {}, "deduped": 0,
    }
    for t in tools:
        orig = getattr(t, "on_invoke_tool", None)
        if orig is None or getattr(t, "name", "") in _BUDGET_EXEMPT_TOOLS:
            continue

        # `_name` is bound HERE, not read off `t` inside the closure: `t` is the
        # loop variable, so a late read would give every wrapper the name of the
        # LAST tool in the list — mis-keying the dedupe map and mis-applying the
        # exemptions.
        def _make(_orig, _name):
            async def wrapped(ctx: Any, args: Any) -> Any:
                if cancel_event is not None and cancel_event.is_set():
                    # Observe cancellation at TOOL ENTRY too, not only between
                    # SDK stream events — a chain of blocking S3 calls otherwise
                    # keeps running long after the user hit Stop (and widens the
                    # steer race window). Same soft shape as budget exhaustion.
                    spent["exhausted"] = True
                    return json.dumps({"status": "cancelled",
                                       "next_step": "The user cancelled this turn. Stop "
                                                    "investigating and give your best "
                                                    "answer from what you already have."})
                live = _live_tokens(ctx)
                if live is not None:
                    spent["tokens"] = live
                    if live >= token_limit:
                        # The honest ceiling: this turn has spent its budget in
                        # the unit that bills. Same soft shape as the char
                        # bound — a status with a next step, never a failure.
                        spent["exhausted"] = True
                        spent["stopped_on"] = "tokens"
                        return json.dumps({"status": "budget_exhausted",
                                           "spent_tokens": live,
                                           "budget_tokens": token_limit,
                                           "next_step": _TOOL_BUDGET_EXHAUSTED})
                key = _call_key(_name, args)
                prior = (None if _name in _DEDUPE_EXEMPT_TOOLS
                         else spent["seen"].get(key))
                if prior is not None:
                    # A read-only tool called twice with identical arguments in
                    # one turn returns the same bytes; paying for them again —
                    # and carrying them for every later step — buys nothing.
                    spent["deduped"] += 1
                    return json.dumps({
                        "status": "repeat_call",
                        # Accurate after v0.57.0's compaction: an older result
                        # is still in the conversation but may have been reduced
                        # to its head, so "reuse it" must not promise the full
                        # payload is sitting there intact.
                        "note": "This exact call was already made in this turn. Its "
                                "result is earlier in the conversation (possibly "
                                "compacted to its head). Work from that.",
                        "result_summary": prior})
                if spent["chars"] >= limit:
                    # A soft per-turn boundary, NOT a tool failure: shape it as a
                    # status (not {"error": …}) with an explicit next step, and
                    # flag the turn so the driver offers a "continue" next step —
                    # like the max-turns ceiling — instead of the model emitting a
                    # normal 'final' that reads as a complete answer.
                    spent["exhausted"] = True
                    spent["stopped_on"] = spent["stopped_on"] or "chars"
                    return json.dumps({"status": "budget_exhausted",
                                       "next_step": _TOOL_BUDGET_EXHAUSTED})
                out = await _orig(ctx, args)
                text = str(out or "")
                if spent["chars"] + len(text) > limit:
                    # This SINGLE output would push the turn past its context
                    # budget. Counting-after made the budget a soft post-hoc bound
                    # a single large tool return could blow past; withhold it with
                    # a VALID JSON envelope (truncating the JSON would be
                    # unparseable) and flag the turn so the driver offers 'continue'.
                    spent["exhausted"] = True
                    spent["stopped_on"] = spent["stopped_on"] or "chars"
                    text = json.dumps({"status": "output_too_large",
                                       "next_step": _TOOL_OUTPUT_TOO_LARGE})
                spent["chars"] += len(text)
                spent["seen"][key] = text[:200]
                return text
            return wrapped

        try:
            t.on_invoke_tool = _make(orig, getattr(t, "name", "?"))
        except Exception:  # noqa: BLE001 — frozen/foreign tool object: skip the wrap
            pass
    return spent


