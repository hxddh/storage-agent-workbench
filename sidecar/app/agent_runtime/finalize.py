"""Recoverable-error classifiers, the tool-less finalize pass and the final Work Result shape."""

from __future__ import annotations

from typing import Any

from ..security.redaction import redact_text
from . import model_budget
from .guardrails import strip_chain_of_thought

from .limits import _MAX_OUTPUT
from .prompt import FINALIZE_INSTRUCTIONS

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


def _is_model_timeout(exc: BaseException) -> bool:
    """True for the SDK's per-model-call deadline (`_MODEL_TIMEOUT_S`).

    Treated exactly like a 429: the endpoint did not answer in time, and the
    investigation gathered so far is still good. Discarding it to show a raw
    "model call timed out" would throw away real tool evidence over a slow
    provider, so this joins the recoverable set and the finalize pass writes a
    grounded best-effort answer.

    Matched by TYPE first (the SDK raises `ModelTimeoutError`), with a name
    fallback for the case where the SDK is absent or the error was re-raised
    through a wrapper — the same shape as `_is_max_turns`."""
    try:
        from agents.exceptions import ModelTimeoutError
        if isinstance(exc, ModelTimeoutError):
            return True
    except Exception:  # noqa: BLE001 — SDK not installed (test envs)
        pass
    return type(exc).__name__ == "ModelTimeoutError"


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
    and the investigation trace. Tools=[] guarantees the next call emits text.

    The instructions are the WRITING half only (v0.57.0). This pass has no tools,
    yet it was being sent the full 6,235-char system prompt — 8 of whose 25 lines
    teach tool selection, group unlocking and probe sequencing, none of which it
    can act on. What it still needs is every safety rule and the rules about how
    to write the answer; those are what it is about to do."""
    from .session_agent import _make_agent  # runtime entry owns the builder
    return (_make_agent(creds, [], FINALIZE_INSTRUCTIONS, client_registry),
            prompt + _finalize_directive(activity))


# FLOOR of the answer cap (callers pass a model-elastic cap ≥ this) so large
# enumerations are never truncated in post-processing; the model's own completion
# budget bounds length. When the cap IS hit, the cut is MARKED — never silent.
_ANSWER_CUT_MARKER = ("[TRUNCATED — the answer reached the output cap and was cut "
                      "here; ask to continue for the rest.]")
_MAX_GROUNDING_ITEMS = 12


def _answer_cap(creds: dict[str, Any] | None) -> int:
    """Elastic post-processing cap on the final answer.

    Never below the _MAX_OUTPUT floor, and always ≥ ~4 chars/token of the model's
    completion budget — so this cap can never cut an answer the completion budget
    legitimately allowed the model to emit (it only backstops pathological output).
    """
    if not creds:
        return _MAX_OUTPUT
    return max(_MAX_OUTPUT, 4 * model_budget.completion_token_budget(
        creds.get("model"), creds.get("context_window"), creds.get("max_output_tokens")))


def sanitize_answer_text(text: Any) -> str:
    """Strip CoT → redact → strip again.

    Order matters: redacting FIRST can eat a ``</think>`` tag when a
    credential-shaped token abuts it, after which the strip finds no closing
    pair and persists the entire hidden-reasoning block. Stripping first removes
    the block intact; the second strip is defense in depth for a block whose
    tags only became well-formed after redaction rewrote the text."""
    raw = text if isinstance(text, str) else str(text or "")
    return strip_chain_of_thought(redact_text(strip_chain_of_thought(raw))).strip()


def _cap_answer(text: str, cap: int) -> str:
    if len(text) <= cap:
        return text
    return text[:cap].rstrip() + "\n\n" + _ANSWER_CUT_MARKER


def _grounding_from_activity(activity: list[dict[str, Any]],
                             skill_names: list[str]) -> dict[str, list[str]]:
    """Grounding is DERIVED from what the turn actually did — never claimed by
    the model in a metadata block.

    - skills_used: the skills the agent opened with read_skill this turn.
    - evidence_used: run ids / evidence / dataset targets the tools read.
    - evidence_gaps: the open questions the agent recorded (note_open_question).
    """
    done = [a for a in activity if a.get("status") != "started"]
    skills = []
    for a in done:
        if a.get("tool") == "read_skill" and a.get("target") in skill_names \
                and a.get("target") not in skills:
            skills.append(a["target"])
    evidence: list[str] = []
    gaps: list[str] = []
    for a in done:
        tool = str(a.get("tool") or "")
        target = redact_text(str(a.get("target") or ""))[:200]
        if not target or a.get("ok") is False:
            continue
        if tool in ("read_run_result", "compare_to_last_survey", "query_account_profile",
                    "survey_account", "review_bucket_config", "analyze_uploaded_file",
                    "list_imported_evidence", "aggregate_imported_evidence",
                    "import_evidence", "read_evidence", "lookup_task_evidence"):
            ref = f"{tool}:{target}"
            if ref not in evidence:
                evidence.append(ref)
        elif tool == "note_open_question":
            if target not in gaps:
                gaps.append(target)
    return {"skills_used": skills[:_MAX_GROUNDING_ITEMS],
            "evidence_used": evidence[:_MAX_GROUNDING_ITEMS],
            "evidence_gaps": gaps[:_MAX_GROUNDING_ITEMS]}


def _finalize_contract(raw: Any, skill_names: list[str], activity: list[dict[str, Any]],
                       cap: int | None = None, streamed: str = "") -> dict[str, Any]:
    """The final Work Result of a turn: the sanitized answer plus grounding
    derived from the tool trace. There is no model-written metadata block —
    the answer is plain Markdown, exactly what the user watched stream in."""
    answer = _cap_answer(sanitize_answer_text(raw), cap or _MAX_OUTPUT)
    contract: dict[str, Any] = {"answer": finalize_answer_text(answer, streamed)}
    contract.update(_grounding_from_activity(activity, skill_names))
    contract["skills_offered"] = skill_names
    # Persist only COMPLETED tool records; transient "started" markers are for
    # the live SSE stream, not the durable transcript.
    contract["tool_activity"] = [a for a in activity if a.get("status") != "started"]
    return contract


_EMPTY_ANSWER_FALLBACK = (
    "The model returned no readable answer for this turn — what it did is in the "
    "trace above. Ask again, or rephrase, and I'll re-run it."
)


def finalize_answer_text(parsed_answer: Any, streamed: str) -> str:
    """The text a finished turn PERSISTS.

    1. The run's final output wins — it is authoritative.
    2. Otherwise fall back to what the user actually saw stream in (an
       OpenAI-compatible server that streams ``delta.content`` but returns an
       empty aggregate message is a real shape this app does not control).
    3. Never persist nothing: an empty Work Result is indistinguishable from a
       broken app, so a turn with no usable text says so.
    """
    if isinstance(parsed_answer, str) and parsed_answer.strip():
        return parsed_answer
    recovered = sanitize_answer_text(streamed if isinstance(streamed, str) else "")
    return recovered or _EMPTY_ANSWER_FALLBACK
