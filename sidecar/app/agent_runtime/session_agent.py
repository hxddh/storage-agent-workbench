"""Session assistant — a live, read-only investigator.

When a user asks a question, the deterministic session summary is built first
for grounding; the agent then investigates LIVE using read-only tools
(list_providers, list_buckets, head_bucket, bounded list_objects, and the
review_bucket_* config tools — see ``session_tools``) and answers from their
results. It chooses the provider/bucket itself.

Every tool is read-only, bounded, audited, and secret-safe — there are no
mutating or destructive operations, and credentials never reach the model. A
file the user ATTACHES is local, so the agent analyzes it inline
(``analyze_uploaded_file``) and answers from it. Only CLOUD-side data-moving work
(evidence import/download from a bucket, a large/full scan) or a saved auditable
report is NOT done inline — it is proposed as a next step the user confirms.

There is ONE turn implementation: the streaming run (``build_stream`` +
``stream_events_for``). The blocking endpoint drives the same stream to
completion via the default ``SESSION_LOOP`` (tests may still monkeypatch that
seam with a fake that returns plain text). Output is redacted +
chain-of-thought-stripped + bounded — including the LIVE delta stream, which is
sanitized incrementally before anything reaches the client.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from typing import Any

from ..security.redaction import redact_text
from ..skills import context as skill_context
from ..skills import contract as skill_contract
from . import guardrails
from . import session_action_tools
from . import session_analysis_tools
from . import session_memory_tools
from . import session_tools
from .agent_service import AgentUnavailable
from .guardrails import strip_chain_of_thought, strip_chain_of_thought_stream

_MAX_FACTS = 50  # kept in sync with sessions.summary_builder.MAX_FACTS
_MAX_FINDINGS = 30
# How many recent thread messages the agent sees. 24 (was 12): a small-context
# clip that now just makes the agent lose the thread on a long investigation —
# 24 msgs × _MAX_REPLAY_MSG chars is still tiny under a modern context window.
_MAX_MESSAGES = 24
# Tool-trace lines replayed per prior assistant turn. Each message already
# persists its tool_activity (the one-line-per-call trace shown in the UI); we
# surface it into the next turn's context so the agent sees WHAT it already
# probed and doesn't re-run the same checks. Cheap continuity — already-persisted,
# already-sanitized data; not summarization/compaction.
_MAX_REPLAY_TOOLS = 15
# Enumerations can be large (e.g. 96+ buckets in a table). Keep our answer cap
# well above any single model completion so we never truncate a legitimate full
# answer in post-processing.
_MAX_OUTPUT = 48000
# Without an explicit max_tokens the provider applies a small default; for a
# reasoning model (e.g. deepseek-v4-pro) the thinking budget then leaves almost
# nothing for the answer, truncating long enumerations mid-table. The budget
# must comfortably cover the post-processing answer cap (_MAX_OUTPUT ≈ 12k
# tokens), otherwise the prompt mandates full enumeration the completion budget
# can't hold. (The installed Agents SDK's chat-completions streaming path does
# not surface finish_reason, so a provider-side length cut cannot be detected
# here — the generous budget is the mitigation.)
_MAX_COMPLETION_TOKENS = 16384
# A real investigation chains several probes (test_credentials → head_bucket →
# test_addressing_style → list_objects → head_object …); keep a generous but
# bounded ceiling so multi-step diagnoses complete without runaway loops.
# 40 (was 24/16): the RIGHT governor of turn depth is the tool-OUTPUT budget
# below (elastic on the context the model actually consumes), not this raw step
# count. This ceiling is now demoted to a runaway-loop SAFETY stop set well above
# what a real deep investigation needs — so a shallow-output but deep probe (many
# small head/list/latency calls across buckets) is no longer cut short at an
# arbitrary step number, while a heavy-output one is still bounded by real context
# use. The tool-less finalize pass still guarantees termination, and the
# context-overflow → finalize path is the backstop if a provider window is hit.
_MAX_TURNS = 40
# Bound on the user's message as embedded in the prompt. Truncation is NEVER
# silent: the cut is marked in the prompt so the agent knows it saw a prefix
# (see build_session_prompt) — the same "no silent caps" rule as ingestion.
_MAX_USER_MSG = 16000
# Bound on each replayed prior message in the context. Also never silent.
# 4000 (was 1000): 1000 chars clipped mid-answer on any substantial turn, so the
# agent saw only truncated tails of its own prior reasoning; 4000 keeps a full
# normal answer while staying bounded (24 × 4000 ≈ 24k tokens of thread history).
_MAX_REPLAY_MSG = 4000
# Per-turn cumulative budget on tool OUTPUT characters handed to the model.
# This is the PRIMARY, elastic governor of how deep a turn goes: it tracks the
# context the model actually consumes, so a turn runs as deep as it needs until
# real context pressure (not an arbitrary step count) says to synthesize. A
# bound, not a gate — once exhausted, further tool calls return a short note
# telling the model to synthesize, so a context-window overflow never becomes a
# hard failure mid-investigation. 200k chars ≈ 50k tokens of tool output, which
# leaves ample room under a modern 200k-token context for the prompt + reasoning;
# the overflow → finalize path is the backstop above it.
_MAX_TOOL_OUTPUT_CHARS = 200_000
_TOOL_BUDGET_EXHAUSTED = (
    "This turn's tool-output budget is used up — synthesize your findings from what "
    "you've already gathered and answer now. This budget resets if the user continues."
)
# Memory tools stay usable even after the budget is spent: recording a finding
# is how the model synthesizes, and their outputs are a few bytes.
_BUDGET_EXEMPT_TOOLS = {
    "note_fact", "record_finding", "note_open_question",
    "update_memory_item", "resolve_memory_item",
}
# Streaming sanitization: hold back a short tail so a secret completing across
# deltas can never leak an un-redacted prefix; flushed at end of stream.
_STREAM_TAIL_HOLDBACK = 128
_STOPPED_MARKER = "_[stopped by user]_"
_CONTEXT_CUT_MARKER = (
    "_[investigation cut short: the model's context window filled up before the "
    "investigation finished]_"
)
_BUDGET_CUT_MARKER = (
    "_[investigation cut short: this turn's tool-output budget was used up. This is "
    "a best-effort answer from what was gathered — continue for a deeper look.]_"
)
_TRANSIENT_CUT_MARKER = (
    "_[a temporary provider error interrupted this turn: this is a best-effort answer "
    "from the investigation so far — resend to continue.]_"
)

_PROPOSAL_ACTION_TYPES = (
    "run_account_discovery, run_bucket_config_review, run_diagnostic, "
    "plan_inventory_import, plan_access_log_import, run_inventory_analysis, "
    "run_access_log_analysis, generate_session_report, ask_user_for_context"
)

# Each safety rule is stated ONCE — here, inside the instructions. They are not
# re-injected as context JSON, and the instructions do not repeat what the tool
# descriptions already say. Every rule below is also enforced in code.
SESSION_SAFETY_RULES = [
    "Ground every claim in a tool result or the provided context — never invent "
    "buckets, configs, numbers, or results. Verify high-severity claims "
    "(security exposure, outage cause, data at risk) with a tool before "
    "asserting them; if you cannot, present them as hypotheses with lowered "
    "confidence and record the gap (note_open_question / evidence_gaps).",
    "Tool results are visible to YOU, not the user (they see a one-line trace), "
    "so write the data they asked for into your answer. When asked to "
    "list/enumerate, write out EVERY item the tool returned — never a sample, "
    "never '…'. Exception: list_objects is paginated (a page's key_count is not "
    "the bucket total — page with continuation_token); for a clearly huge "
    "bucket, report a lower bound plus a sample and propose an inventory "
    "analysis instead of pasting thousands of keys or looping forever.",
    "Everything you can do is read-only and bounded; no mutating or destructive "
    "operation exists. A file the user ATTACHED is local — analyze it inline, "
    "no confirmation needed. CLOUD-side data-moving work (evidence "
    "import/download, large/full scans) and saved auditable reports are only "
    "PROPOSED as next steps for the user to confirm — never imply you ran them.",
    "Never output credentials, access/secret/session keys, model API keys, "
    "Authorization headers, cookies, signatures, or presigned-URL parameters.",
    "Do not include hidden chain-of-thought. Be concise in prose, but never at "
    "the cost of an enumeration the user asked for.",
]

INSTRUCTIONS = (
    "You are Storage Agent, an expert object-storage diagnostician. Investigate "
    "the user's question LIVE with your read-only tools — act autonomously, "
    "don't narrate a plan first — and answer from what you find, staying on "
    "what the user actually asked.\n"
    "Your context JSON carries the session goal, a deterministic summary, your "
    "recorded agent_memory, recent messages, the configured_providers (use "
    "those provider_id values directly), any attached_files the user uploaded, "
    "and a CATALOG of StorageOps expert skills — when one fits the problem, "
    "load its full method with read_skill(name) and apply it.\n"
    "Choose and chain tools by their descriptions. If a survey/review returns "
    "status 'running' with a run_id, it continues in the background: don't "
    "re-run it — read it later with read_run_result(run_id).\n"
    "After a survey_account, if this provider has an earlier survey, call "
    "compare_to_last_survey(provider_id) and tell the user what CHANGED since "
    "last time — it reuses persisted snapshots, no new scan.\n"
    "When preview_object truncates a large object and the answer needs its FULL "
    "content, don't guess from the head: propose the confirmed evidence import "
    "(for a bucket file) or use analyze_uploaded_file (for a file the user "
    "attached) so the whole file is analyzed deterministically.\n"
    "Record durable facts, notable findings, and open questions with note_fact "
    "/ record_finding / note_open_question (update_memory_item / "
    "resolve_memory_item to correct or close them). Each recent assistant message "
    "carries a tools_run trace of the read-only probes that turn already ran — "
    "consult it and DON'T re-run a check you've already done; re-fetch only when "
    "you need fuller detail than the one-line result. Between that trace and "
    "agent_memory, reuse what earlier turns established instead of re-deriving it.\n"
    "Your step budget is bounded: probe what the question needs, and if a "
    "complete answer would need more steps, give your best grounded answer and "
    "say what remains.\n\n"
    "SAFETY RULES:\n" + "\n".join(f"- {r}" for r in SESSION_SAFETY_RULES) + "\n\n"
    f"When you propose a concrete next step, write it in your own words — you "
    f"are NOT limited to a fixed menu. These well-known types get a one-click "
    f"affordance: {_PROPOSAL_ACTION_TYPES}; the data-moving imports always "
    f"route through a confirm-before-download planner; any other proposal is "
    f"handed back to you to carry out with your own tools."
)


def _build_agent_memory_block(memory: list[dict[str, Any]] | None) -> dict[str, list[Any]]:
    """Group agent-authored memory into recalled facts/findings/questions.

    ``memory`` is oldest-first; we keep the most RECENT items per kind (the tail)
    so a long session surfaces its latest learnings rather than stale early ones.
    Each item carries its id so the agent can update/resolve it later.
    """
    facts: list[dict[str, Any]] = []
    findings: list[dict[str, Any]] = []
    questions: list[dict[str, Any]] = []
    for m in (memory or []):
        kind = m.get("kind")
        text = redact_text(str(m.get("text", "")))[:300]
        if not text:
            continue
        mem_id = str(m.get("id") or "")
        if kind == "fact":
            facts.append({"id": mem_id, "text": text,
                          "confidence": m.get("confidence") or "medium"})
        elif kind == "finding":
            findings.append({"id": mem_id, "title": text,
                             "severity": m.get("severity") or "info"})
        elif kind == "open_question":
            questions.append({"id": mem_id, "text": text})
    return {
        "recorded_facts": facts[-_MAX_FACTS:],
        "recorded_findings": findings[-_MAX_FINDINGS:],
        "open_questions": questions[-_MAX_FACTS:],
    }


def _clip_marked(text: str, cap: int) -> str:
    """Bound text with an EXPLICIT truncation marker (never a silent cut)."""
    if len(text) <= cap:
        return text
    omitted = len(text) - cap
    return text[:cap] + f" [TRUNCATED: {omitted} more characters cut]"


def _replay_tools(activity: list[dict[str, Any]] | None) -> list[str]:
    """Compact 'what I already checked' trace from a prior turn's persisted
    tool_activity, so the next turn doesn't re-probe. Completed records only
    (the transient 'started' markers are UI-only), one bounded line per call,
    already sanitized on write and redacted again defensively."""
    lines: list[str] = []
    for a in (activity or []):
        if a.get("status") == "started":
            continue
        tool = str(a.get("tool", ""))[:40]
        if not tool:
            continue
        target = str(a.get("target", ""))[:80]
        result = str(a.get("result", ""))[:60]
        line = f"{tool} · {target} → {result}" if target else f"{tool} → {result}"
        lines.append(redact_text(line))
    if len(lines) > _MAX_REPLAY_TOOLS:
        extra = len(lines) - _MAX_REPLAY_TOOLS
        lines = lines[:_MAX_REPLAY_TOOLS] + [f"[+{extra} more tool calls this turn]"]
    return lines


def _replay_message(m: dict[str, Any]) -> dict[str, Any]:
    """One replayed message: role + clipped content, plus a bounded tools_run
    trace for assistant turns (cross-turn continuity of what was already probed)."""
    out = {"role": m.get("role"),
           "content": _clip_marked(redact_text(str(m.get("content", ""))), _MAX_REPLAY_MSG)}
    if m.get("role") == "assistant":
        tools = _replay_tools(m.get("tool_activity"))
        if tools:
            out["tools_run"] = tools
    return out


def build_session_context(
    session: dict[str, Any],
    summary: dict[str, Any],
    recent_messages: list[dict[str, Any]],
    agent_memory: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Bounded, redacted context — the ONLY thing the model sees."""
    findings = []
    for f in (summary.get("findings") or [])[:_MAX_FINDINGS]:
        findings.append({
            "severity": str(f.get("severity", "info"))[:32],
            "confidence": str(f.get("confidence", "medium"))[:16],
            "title": redact_text(str(f.get("title", "")))[:200],
            "interpretation": redact_text(str(f.get("interpretation", "")))[:300],
            "source_run_id": str(f.get("source_run_id") or "")[:64],
        })
    context = {
        "session": {
            "title": redact_text(str(session.get("title", ""))),
            "goal": redact_text(str(session.get("goal") or "")),
            "status": session.get("status", "active"),
        },
        "summary": {
            "known_facts": [
                {"text": redact_text(str(f.get("text", "")))[:300],
                 "confidence": f.get("confidence", "medium"),
                 "source_run_id": str(f.get("source_run_id") or "")[:64]}
                for f in (summary.get("known_facts") or [])[:_MAX_FACTS]
            ],
            "findings": findings,
            "open_questions": [redact_text(str(q))[:300] for q in (summary.get("open_questions") or [])[:_MAX_FACTS]],
            # NOTE: the deterministic rule-engine "next_actions" menu is intentionally
            # NOT injected — the agent proposes its own next steps. (Removed in v0.20.)
            "limitations": [redact_text(str(x))[:300] for x in (summary.get("limitations") or [])[:_MAX_FACTS]],
        },
        # Things YOU recorded in earlier turns of this session (via note_fact /
        # record_finding / note_open_question). Reuse them; don't re-derive.
        "agent_memory": _build_agent_memory_block(agent_memory),
        # Prior assistant turns carry a `tools_run` trace of the read-only probes
        # they already ran (bounded) — so this turn sees what was checked and
        # re-fetches only what it needs fuller detail on, instead of re-probing.
        "recent_messages": [_replay_message(m) for m in recent_messages[-_MAX_MESSAGES:]],
        # NOTE: safety rules live ONCE in the instructions — not re-injected here.
    }
    guardrails.assert_no_secrets_in_context(context)
    return context


def render_context_text(context: dict[str, Any]) -> str:
    return json.dumps(context, indent=2, default=str)


def _make_agent(creds: dict[str, Any], tools: list[Any], instructions: str,
                client_registry: list[Any] | None = None) -> Any:
    """Build the session Agent via the shared per-run builder (no SDK globals)."""
    from .agent_service import build_agent
    return build_agent(creds, tools, instructions, name="Storage Agent",
                       max_tokens=_MAX_COMPLETION_TOKENS, parallel_tool_calls=False,
                       client_registry=client_registry)


# --- graceful step-budget finalize -----------------------------------------
# When the agent exhausts its turn budget (max_turns) the OpenAI Agents SDK
# raises MaxTurnsExceeded. That must NOT surface as a hard error: instead we make
# ONE tool-less model call that synthesizes a best-effort answer from the work
# already done. Tools are disabled, so the model can only emit text — the call is
# guaranteed to terminate with a grounded answer. The turn budget is preserved
# (N tool-loop turns + 1 tool-less finalize); nothing new can be probed here.
# The SAME pass handles a provider context-length overflow: the finalize call is
# a fresh, small request (prompt + trace), so it fits where the overloaded
# tool-loop conversation no longer did.

_FINALIZE_FALLBACK = (
    "I reached my investigation step budget before I could finish this. The steps "
    "I completed are shown above — tell me to continue and I'll pick up from there."
)


def _is_max_turns(exc: BaseException) -> bool:
    """True if exc is the SDK's max-turns signal. The SDK's MaxTurnsExceeded
    type is checked first; the class-name/message match is only a fallback for
    exceptions re-raised through other layers."""
    try:
        from agents.exceptions import MaxTurnsExceeded
        if isinstance(exc, MaxTurnsExceeded):
            return True
    except Exception:  # noqa: BLE001 — SDK not installed (test envs)
        pass
    return type(exc).__name__ == "MaxTurnsExceeded" or "max turns" in str(exc).lower()


# Specific enough to be unambiguous — an unrelated error won't carry these, so
# they are trusted wherever they appear.
_CONTEXT_OVERFLOW_NEEDLES = (
    "context length", "context_length_exceeded", "maximum context length",
)
# Generic phrasing that CAN appear in unrelated provider/tool errors. These are
# trusted only when the error is bad-request-class (a real overflow is always a
# 400), so a stray 5xx/connection error whose text merely contains one of them
# isn't reclassified into a fabricated cut-short answer.
_CONTEXT_OVERFLOW_WEAK_NEEDLES = (
    "context window", "input is too long", "prompt is too long",
)


def _is_context_overflow(exc: BaseException) -> bool:
    """True if exc is a provider context-length error (openai.BadRequestError
    carrying a context-length message, or an equivalent message from a
    compatible provider)."""
    code = str(getattr(exc, "code", "") or "").lower()
    if code == "context_length_exceeded":
        return True
    msg = str(exc).lower()
    if any(n in msg for n in _CONTEXT_OVERFLOW_NEEDLES):
        return True
    # Generic needles: every provider reaches the model through the openai SDK,
    # so a genuine overflow surfaces as an openai.BadRequestError (status 400).
    status = getattr(exc, "status_code", None)
    type_name = type(exc).__name__.lower()
    is_bad_request = status == 400 or "badrequest" in type_name or "invalidrequest" in type_name
    return is_bad_request and any(n in msg for n in _CONTEXT_OVERFLOW_WEAK_NEEDLES)


_TRANSIENT_STATUS = {429, 500, 502, 503, 504}


def _is_transient_provider_error(exc: BaseException) -> bool:
    """True for a retryable PROVIDER-RESPONSE error — a rate limit (429) or a
    server error (5xx) the model provider returned — as opposed to a deterministic
    client error (400/401/403). On these, discarding the whole investigation with a
    raw "Session assistant failed: Error code: 429" is the worst outcome; instead
    the turn salvages a grounded best-effort answer from the trace already gathered
    (via the tool-less finalize pass) and offers to continue.

    Deliberately NARROW: a raw transport/connection reset (no HTTP status) is left
    to propagate so the SSE client falls back to the blocking turn (a full re-run),
    which is the pre-existing recovery for those. Auth failures (401/403) and
    context/tool-sequence 400s are not transient and are handled elsewhere."""
    status = getattr(exc, "status_code", None)
    if status in _TRANSIENT_STATUS:
        return True
    # Provider-response exception types that carry a retryable status even when the
    # attribute was lost through a re-raise (rate limit / 5xx). NOT the
    # connection/timeout transport types — those go to the fallback re-run.
    type_name = type(exc).__name__.lower()
    if any(t in type_name for t in ("ratelimit", "internalserver", "serviceunavailable")):
        return True
    msg = str(exc).lower()
    return any(f"error code: {s}" in msg for s in _TRANSIENT_STATUS)


def _is_tool_call_sequence_error(exc: BaseException) -> bool:
    """True if exc is a provider 400 rejecting the reconstructed message list
    because an assistant ``tool_calls`` message isn't followed by a ``tool``
    result for every ``tool_call_id`` (an SDK / OpenAI-compatible-provider
    tool-call sequencing mismatch — e.g. a provider that emits multiple tool
    calls despite ``parallel_tool_calls=False``).

    The in-flight conversation can't be repaired in place, but the tool-less
    finalize pass rebuilds from a FRESH prompt (no tool_calls history), so
    treating this as recoverable lets the turn synthesize a grounded best-effort
    answer instead of surfacing a raw 400."""
    msg = str(exc).lower()
    is_400 = getattr(exc, "status_code", None) == 400 or "error code: 400" in msg or "code: 400" in msg
    if not is_400:
        return False
    return (
        "insufficient tool messages" in msg
        or "tool_call_id" in msg
        or ("tool_calls" in msg and "must be followed" in msg)
    )


def _finalize_directive(activity: list[dict[str, Any]] | None) -> str:
    rows = [a for a in (activity or []) if a.get("status") != "started"]
    trace = "\n".join(
        f"- {a.get('tool', '')} {a.get('target', '')}: {a.get('result', '')}".strip()
        for a in rows[-40:]
    ) or "- (no tool calls completed)"
    return (
        "\n\n[STEP BUDGET REACHED] You have used your investigation step budget — "
        "do NOT attempt any more tools. Using the context above and the "
        "investigation trace below, write your BEST answer now from what you "
        "already gathered. Be explicit that it is based on the investigation so "
        "far and may be incomplete, and offer to continue if the user wants a "
        "deeper look.\nInvestigation trace so far:\n" + trace
    )


def _finalize_agent_and_prompt(creds: dict[str, Any], prompt: str,
                               activity: list[dict[str, Any]] | None,
                               client_registry: list[Any] | None = None):
    """A TOOL-LESS agent + the original prompt augmented with a finalize directive
    and the investigation trace. Tools=[] guarantees the next call emits text."""
    return (_make_agent(creds, [], INSTRUCTIONS, client_registry),
            prompt + _finalize_directive(activity))


def _build_tools(conn: Any, function_tool: Callable, activity: list[dict[str, Any]] | None,
                 session_id: str | None, turn_id: str | None = None,
                 cancel_event: Any = None) -> list[Any]:
    """The agent's full read-only toolset (no autonomy toggle — always available)."""
    if conn is None:
        return []
    tools = session_tools.build(conn, function_tool, activity)
    tools += session_action_tools.build(conn, function_tool, activity, session_id, turn_id,
                                        cancel_event=cancel_event)
    # Working-memory tools are always available (recording is cloud-read-only).
    tools += session_memory_tools.build(conn, function_tool, session_id, activity)
    # Uploaded-file analysis is always available (local, read-only, sanitized) so
    # the agent can analyze an attached log/inventory itself and answer inline.
    tools += session_analysis_tools.build(conn, function_tool, session_id, activity)
    return tools


def _install_tool_output_budget(tools: list[Any],
                                limit: int = _MAX_TOOL_OUTPUT_CHARS) -> dict[str, int]:
    """Cap the CUMULATIVE characters of tool output handed to the model per turn.

    A bound, not a gate: once ``limit`` is spent, every further (non-memory)
    tool call returns a short structured note telling the model to synthesize —
    so a sprawling investigation degrades into an answer instead of blowing the
    provider's context window. Wraps each SDK FunctionTool's ``on_invoke_tool``;
    fake tools in tests (plain callables) are left untouched.
    """
    spent = {"chars": 0, "exhausted": False}
    for t in tools:
        orig = getattr(t, "on_invoke_tool", None)
        if orig is None or getattr(t, "name", "") in _BUDGET_EXEMPT_TOOLS:
            continue

        def _make(_orig):
            async def wrapped(ctx: Any, args: Any) -> Any:
                if spent["chars"] >= limit:
                    # A soft per-turn boundary, NOT a tool failure: shape it as a
                    # status (not {"error": …}) with an explicit next step, and
                    # flag the turn so the driver offers a "continue" next step —
                    # like the max-turns ceiling — instead of the model emitting a
                    # normal 'final' that reads as a complete answer.
                    spent["exhausted"] = True
                    return json.dumps({"status": "budget_exhausted",
                                       "next_step": _TOOL_BUDGET_EXHAUSTED})
                out = await _orig(ctx, args)
                spent["chars"] += len(str(out or ""))
                return out
            return wrapped

        try:
            t.on_invoke_tool = _make(orig)
        except Exception:  # noqa: BLE001 — frozen/foreign tool object: skip the wrap
            pass
    return spent


def _build_prompt(
    session: dict[str, Any],
    summary: dict[str, Any],
    recent_messages: list[dict[str, Any]],
    user_message: str,
    conn: Any,
    attachments: list[dict[str, Any]] | None = None,
) -> tuple[str, list[str], dict[str, Any]]:
    """Build the sanitized prompt + skill names + context (shared).

    Skills follow progressive disclosure: the full catalog (name + description)
    goes in the prompt and the agent loads any relevant skill on demand via the
    read_skill tool. skill_names is the allow-list of what it may cite as used.
    """
    agent_memory: list[dict[str, Any]] = []
    if conn is not None and session.get("id"):
        try:
            from ..repositories import sessions as sessions_repo
            agent_memory = sessions_repo.list_agent_memory(conn, session["id"])
        except Exception:  # noqa: BLE001
            agent_memory = []
    context = build_session_context(session, summary, recent_messages, agent_memory)
    skill_names = skill_context.skill_names()

    prompt_parts = [render_context_text(context)]
    # Pre-list configured providers so the agent skips a list_providers round
    # trip (latency) and already knows the provider_id values. No secrets.
    providers: list[dict[str, Any]] = []
    if conn is not None:
        try:
            from ..repositories import cloud_providers as cloud_repo
            providers = [{"provider_id": p.id, "name": p.name, "type": p.provider_type,
                          "region": p.region, "endpoint": p.endpoint_url}
                         for p in cloud_repo.list_all(conn)]
        except Exception:  # noqa: BLE001
            providers = []
    prompt_parts.append("configured_providers:\n" + json.dumps(providers, ensure_ascii=False))
    # Files the user attached this turn (uploaded but not yet analyzed). The agent
    # should analyze the relevant one with analyze_uploaded_file and answer inline.
    if attachments:
        att = [{"dataset_id": a.get("id"), "filename": a.get("source_filename"),
                "type": a.get("dataset_type")} for a in attachments]
        prompt_parts.append(
            "attached_files (the user just uploaded these; analyze the relevant one with "
            "analyze_uploaded_file and base your answer on the result — do NOT ignore them):\n"
            + json.dumps(att, ensure_ascii=False)
        )
    catalog = skill_context.catalog_text()
    if catalog:
        prompt_parts.append(catalog)
    # Never truncate the user's question silently: a long paste (error output,
    # config dump) is cut at _MAX_USER_MSG with an explicit marker so the agent
    # knows it saw a prefix and can say so / ask for the rest as an attachment.
    msg = redact_text(user_message)
    if len(msg) > _MAX_USER_MSG:
        omitted = len(msg) - _MAX_USER_MSG
        msg = (
            msg[:_MAX_USER_MSG]
            + f"\n[TRUNCATED: {omitted} more characters were cut here. You saw only a "
            "prefix of the user's message — say so explicitly, and suggest attaching "
            "the full text as a file for complete analysis.]"
        )
    prompt_parts.append(f"User question:\n{msg}")
    prompt_parts.append(skill_contract.CONTRACT_INSTRUCTION)
    return "\n\n".join(prompt_parts), skill_names, context


_CONTINUE_ACTION = "continue_investigation"


def _with_continue_proposal(contract: dict[str, Any]) -> dict[str, Any]:
    """Offer a one-click 'continue investigation' next-step on a CUT-SHORT turn.

    When a turn ends via the finalize pass (it hit the step ceiling or the context
    window before the agent naturally concluded), the investigation isn't
    finished. Rather than silently stopping, surface a proposal the user can click
    to resume — a suggestion, not automation (the user still confirms by clicking).
    Deduped so we never double it if the agent already proposed a continuation.
    """
    from ..sessions import next_actions
    proposals = contract.get("next_action_proposals") or []
    if any(p.get("action_type") == _CONTINUE_ACTION for p in proposals):
        return contract
    norm = next_actions.normalize_proposal({
        "action_type": _CONTINUE_ACTION,
        "title": "Continue the investigation",
        "reason": "The previous turn reached its depth limit before finishing — "
                  "resume and pursue the threads it hadn't reached yet.",
        "confidence": "high",
    })
    if norm:
        contract["next_action_proposals"] = [norm, *proposals]
    return contract


def _finalize_contract(raw: Any, skill_names: list[str], activity: list[dict[str, Any]]) -> dict[str, Any]:
    contract = skill_contract.parse_agent_contract(raw, allowed_skill_names=skill_names)
    contract["answer"] = contract["answer"][:_MAX_OUTPUT]
    # Bind skills_used to skills the agent ACTUALLY loaded via read_skill this
    # turn — the model can't merely *claim* a skill it never opened (keeps the
    # report honest). read_skill records {tool, target=skill_name} in activity.
    read_skills = {a.get("target") for a in activity
                   if a.get("tool") == "read_skill" and a.get("status") != "started"}
    contract["skills_used"] = [s for s in contract.get("skills_used", []) if s in read_skills]
    contract["skills_offered"] = skill_names
    # Persist only COMPLETED tool records; transient "started" markers are for
    # the live SSE stream, not the durable transcript.
    contract["tool_activity"] = [a for a in activity if a.get("status") != "started"]
    return contract


# --- the single (streaming) turn implementation ------------------------------


def _start_streamed_run(spec: dict[str, Any], clients: list[Any] | None = None):
    """Start the SDK streaming run for a prepared spec.

    Returns (result_streaming, finalize, clients). ``clients`` collects every
    AsyncOpenAI client created for this turn so the driver can close them when
    the turn ends. Raises AgentUnavailable if the SDK is missing.
    """
    try:
        import openai  # noqa: F401
        from agents import Runner, function_tool
    except Exception as exc:  # noqa: BLE001
        raise AgentUnavailable("OpenAI Agents SDK is not available in this environment.") from exc

    creds = spec["creds"]
    activity: list[dict[str, Any]] = spec["activity"]
    # ``clients`` is CALLER-OWNED: _make_agent registers each per-turn client in
    # it BEFORE run_streamed, so if anything here raises the caller's finally can
    # still close it (otherwise a client created just before a run_streamed error
    # would leak its HTTP pool, since stream_events_for's close never runs).
    if clients is None:
        clients = []
    tools = _build_tools(spec.get("conn"), function_tool, activity,
                         spec.get("session_id"), spec.get("turn_id"),
                         spec.get("cancel_event"))
    budget = _install_tool_output_budget(tools)
    spec["budget"] = budget  # readable by the blocking driver, which owns `spec`
    # _make_agent disables parallel tool calls (chat-completions providers like
    # DeepSeek can emit malformed follow-ups with streaming + parallel calls) and
    # uses a per-run client so concurrent sessions don't race on SDK globals.
    agent = _make_agent(creds, tools, INSTRUCTIONS, clients)
    result = Runner.run_streamed(agent, spec["prompt"], max_turns=_MAX_TURNS)

    async def _finalize() -> str:
        """One tool-less call to synthesize a grounded answer when the step
        budget (or the context window) is hit mid-stream. Never raises —
        returns a safe fallback on any error."""
        try:
            fa, fp = _finalize_agent_and_prompt(creds, spec["prompt"], activity, clients)
            fr = await Runner.run(fa, fp, max_turns=2)
            return getattr(fr, "final_output", "") or _FINALIZE_FALLBACK
        except Exception:  # noqa: BLE001
            return _FINALIZE_FALLBACK

    return result, _finalize, clients


def _streamed_session_loop(spec: dict[str, Any]) -> dict[str, Any]:
    """Default SESSION_LOOP: drive the SAME streaming implementation to
    completion on a private event loop and return the final contract dict.

    This is the blocking endpoint's turn — there is no second, parallel
    tool-loop implementation. Tests monkeypatch SESSION_LOOP with fakes that
    return plain text; ``answer`` handles both shapes.
    """
    try:
        async def _drive() -> dict[str, Any]:
            # Runner.run_streamed schedules the agent loop via asyncio.create_task,
            # so it MUST be started from WITHIN the running loop — not before it.
            # Calling _start_streamed_run() outside run_until_complete raises
            # "no running event loop" (the blocking-fallback crash a client hit
            # when it fell back to POST /messages after switching sessions).
            clients: list[Any] = []
            try:
                result, finalize, _ = _start_streamed_run(spec, clients)
            except BaseException:
                # _start_streamed_run raised after creating a client → close it
                # here, since stream_events_for (the normal closer) never runs.
                await _close_clients(clients)
                raise
            final: dict[str, Any] = {}
            async for kind, data in stream_events_for(
                    result, spec["activity"], spec.get("skill_names") or [], finalize,
                    cancel_event=spec.get("cancel_event"), clients=clients,
                    budget=spec.get("budget")):
                if kind == "final":
                    final = data
            return final

        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(_drive())
        finally:
            loop.close()
    except AgentUnavailable:
        raise
    except Exception as exc:  # noqa: BLE001
        raise AgentUnavailable(f"Session assistant failed: {redact_text(str(exc))}") from exc


# Monkeypatch in tests to inject a fake loop (no SDK / no API key).
SESSION_LOOP: Callable[[dict[str, Any]], Any] = _streamed_session_loop


def answer(
    session: dict[str, Any],
    summary: dict[str, Any],
    recent_messages: list[dict[str, Any]],
    user_message: str,
    creds: dict[str, Any],
    conn: Any = None,
    turn_id: str | None = None,
    attachments: list[dict[str, Any]] | None = None,
    cancel_event: Any = None,
) -> dict[str, Any]:
    """Skill-grounded, sanitized session answer contract. Raises AgentUnavailable.

    Returns {answer, skills_used, evidence_used, evidence_gaps,
    next_action_proposals} — all sanitized + CoT-stripped; proposals coerced +
    forbidden-token-filtered. Drives the same streaming implementation as the
    SSE endpoint (via SESSION_LOOP) to completion.
    """
    prompt, skill_names, context = _build_prompt(session, summary, recent_messages, user_message,
                                                 conn, attachments)

    activity: list[dict[str, Any]] = []
    spec = {"context": context, "prompt": prompt, "instructions": INSTRUCTIONS,
            "creds": creds, "conn": conn, "activity": activity,
            "session_id": session.get("id"), "turn_id": turn_id,
            "skill_names": skill_names, "cancel_event": cancel_event}
    raw = SESSION_LOOP(spec)
    if isinstance(raw, dict):  # the real (streamed) loop returns the contract
        return raw
    return _finalize_contract(raw, skill_names, activity)


# --- Streaming path (SDK-only; used by the SSE endpoint) --------------------

def build_stream(
    session: dict[str, Any],
    summary: dict[str, Any],
    recent_messages: list[dict[str, Any]],
    user_message: str,
    creds: dict[str, Any],
    conn: Any,
    turn_id: str | None = None,
    attachments: list[dict[str, Any]] | None = None,
    cancel_event: Any = None,
    clients: list[Any] | None = None,
):
    """Set up a streaming run.

    Returns (result_streaming, activity, skill_names, finalize, clients, budget).
    ``clients`` may be passed in so the CALLER owns closing them even if this
    setup raises after a client was created (see _start_streamed_run). ``budget``
    is the per-turn tool-output budget state; pass it to ``stream_events_for`` so
    a budget-exhausted turn is marked cut-short with a "continue" proposal.
    Raises AgentUnavailable if the SDK/key is unavailable — caller should then
    fall back to the blocking endpoint.
    """
    if clients is None:
        clients = []
    prompt, skill_names, _context = _build_prompt(session, summary, recent_messages, user_message,
                                                  conn, attachments)
    activity: list[dict[str, Any]] = []
    spec = {"prompt": prompt, "creds": creds, "conn": conn, "activity": activity,
            "session_id": session.get("id"), "turn_id": turn_id,
            "cancel_event": cancel_event}
    result, finalize, _ = _start_streamed_run(spec, clients)
    return result, activity, skill_names, finalize, clients, spec.get("budget")


def _hold_back_contract(text: str) -> str:
    """Hold back everything from the answer-contract JSON sentinel.

    A legitimate ```json example in the answer is released once its fence
    closes and it turns out NOT to be the contract; the contract block itself
    (and any still-open fence) never streams as visible text.
    """
    sentinel = skill_contract.CONTRACT_SENTINEL
    pos = 0
    while True:
        i = text.find(sentinel, pos)
        if i == -1:
            return text
        close = text.find("```", i + len(sentinel))
        if close == -1:
            return text[:i]  # fence not closed yet — hold back until it is
        if skill_contract.is_contract_json(text[i + len(sentinel):close].strip()):
            return text[:i]
        pos = close + 3


class _StreamSanitizer:
    """Incrementally sanitize the live delta stream.

    Maintains the accumulated raw text; each push computes the sanitized view
    (streaming-safe CoT strip → contract-block holdback → redaction), holds back
    a ~128-char tail (flushed at the end) so a secret completing across deltas
    can't leak an un-redacted prefix, and emits only the monotonic extension of
    what was already emitted. When the sanitized view diverges from the emitted
    prefix, nothing more is emitted — the persisted final answer corrects the
    client's view.
    """

    def __init__(self) -> None:
        self.emitted = ""

    @staticmethod
    def _visible(raw: str) -> str:
        return redact_text(_hold_back_contract(strip_chain_of_thought_stream(raw)))

    def push(self, raw_acc: str, final: bool = False) -> str:
        visible = self._visible(raw_acc)
        if not final:
            if len(visible) <= _STREAM_TAIL_HOLDBACK:
                return ""
            visible = visible[:len(visible) - _STREAM_TAIL_HOLDBACK]
        if len(visible) <= len(self.emitted) or not visible.startswith(self.emitted):
            return ""
        out = visible[len(self.emitted):]
        self.emitted = visible
        return out


def _cancel_streaming(result: Any) -> None:
    """Best-effort cancel of the SDK's RunResultStreaming (0.17.x: .cancel())."""
    cancel = getattr(result, "cancel", None)
    if callable(cancel):
        try:
            cancel()
        except Exception:  # noqa: BLE001 — cancellation is best-effort
            pass


async def _close_clients(clients: list[Any] | None) -> None:
    """Close every per-turn AsyncOpenAI client (they hold open HTTP pools)."""
    for c in (clients or []):
        try:
            await c.close()
        except Exception:  # noqa: BLE001
            pass


async def stream_events_for(result: Any, activity: list[dict[str, Any]], skill_names: list[str],
                            finalize=None, *, cancel_event: Any = None,
                            clients: list[Any] | None = None,
                            budget: dict[str, Any] | None = None):
    """Yield ('delta', text) and ('tool', record) during the run, then
    ('final', contract) when complete.

    - Deltas are SANITIZED live (see _StreamSanitizer): CoT-stripped, redacted,
      contract-block held back, tail held back until the end of the stream.
    - If the run hits its step budget (max_turns) or the provider's context
      window and a ``finalize`` callable was provided, the failure is NOT
      surfaced as an error: the tool trace is flushed, a tool-less finalize
      synthesizes a grounded answer, and the stream ends with a normal 'final'
      (marked as cut short in the context-overflow case).
    - If ``cancel_event`` is set mid-run, the SDK run is cancelled and the
      stream ends with a 'final' contract carrying the PARTIAL sanitized answer
      + a "stopped by user" marker and ``stopped: True``.
    - Every client in ``clients`` is closed when the turn ends, however it ends.
    """
    from openai.types.responses import ResponseTextDeltaEvent
    emitted_tools = 0
    raw_acc = ""
    sanitizer = _StreamSanitizer()
    try:
        try:
            async for event in result.stream_events():
                if cancel_event is not None and cancel_event.is_set():
                    _cancel_streaming(result)
                    while len(activity) > emitted_tools:
                        yield ("tool", activity[emitted_tools])
                        emitted_tools += 1
                    partial = strip_chain_of_thought(redact_text(raw_acc)).strip()
                    answer_text = (partial + "\n\n" if partial else "") + _STOPPED_MARKER
                    contract = _finalize_contract(answer_text, skill_names, activity)
                    contract["stopped"] = True
                    yield ("final", contract)
                    return
                if getattr(event, "type", "") == "raw_response_event" and isinstance(event.data, ResponseTextDeltaEvent):
                    if event.data.delta:
                        raw_acc += event.data.delta
                        out = sanitizer.push(raw_acc)
                        if out:
                            yield ("delta", out)
                while len(activity) > emitted_tools:
                    yield ("tool", activity[emitted_tools])
                    emitted_tools += 1
        except Exception as exc:  # noqa: BLE001
            cut_short = _is_context_overflow(exc) and not _is_max_turns(exc)
            # A transient provider error (429/5xx/reset) is recoverable: rather
            # than discard the whole investigation with a raw error, finalize
            # synthesizes a grounded best-effort answer from the trace gathered so
            # far and offers to continue. Not cut_short (context wasn't the cause).
            transient = (_is_transient_provider_error(exc)
                         and not _is_max_turns(exc) and not cut_short)
            # A tool-call sequencing 400 is recoverable too: finalize rebuilds
            # from a fresh prompt (no tool_calls history), so the turn synthesizes
            # a grounded answer instead of surfacing a raw provider error. It is
            # NOT `cut_short` — no "context filled up" marker, since context is
            # not why it failed.
            recoverable = (_is_max_turns(exc) or cut_short or transient
                           or _is_tool_call_sequence_error(exc))
            if finalize is None or not recoverable:
                raise
            while len(activity) > emitted_tools:
                yield ("tool", activity[emitted_tools])
                emitted_tools += 1
            text = await finalize() or _FINALIZE_FALLBACK
            if cut_short:
                text = text + "\n\n" + _CONTEXT_CUT_MARKER
            elif transient:
                text = text + "\n\n" + _TRANSIENT_CUT_MARKER
            # If sanitized deltas already streamed, the finalize text REPLACES
            # them — skip the delta and let 'final' correct the client's view.
            if not sanitizer.emitted:
                flushed = sanitizer.push(text, final=True)
                if flushed:
                    yield ("delta", flushed)
            # Cut short by the step ceiling or the context window → offer a
            # one-click "continue investigation" next step.
            yield ("final", _with_continue_proposal(
                _finalize_contract(text, skill_names, activity)))
            return
        while len(activity) > emitted_tools:
            yield ("tool", activity[emitted_tools])
            emitted_tools += 1
        # Flush the held-back tail now that the stream is complete.
        tail = sanitizer.push(raw_acc, final=True)
        if tail:
            yield ("delta", tail)
        final_text = getattr(result, "final_output", "") or ""
        # If the per-turn tool-output budget (the PRIMARY depth governor) was what
        # forced the model to stop investigating, the answer is a best-effort cut
        # short — mark it and offer a one-click "continue", exactly like the
        # max-turns ceiling. Without this the deepest turns end as an ordinary
        # 'final' the user can mistake for a complete answer.
        if budget and budget.get("exhausted"):
            if _BUDGET_CUT_MARKER not in final_text:
                final_text = (final_text + "\n\n" + _BUDGET_CUT_MARKER).strip()
            yield ("final", _with_continue_proposal(
                _finalize_contract(final_text, skill_names, activity)))
        else:
            yield ("final", _finalize_contract(final_text, skill_names, activity))
    finally:
        await _close_clients(clients)


__all__ = ["SESSION_LOOP", "build_session_context", "render_context_text", "answer",
           "build_stream", "stream_events_for", "SESSION_SAFETY_RULES", "INSTRUCTIONS"]
