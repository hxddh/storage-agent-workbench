"""Context compaction (v1.12) — summarise-and-continue instead of cut-short.

When the last model call's reported input usage crosses ``TRIGGER_RATIO`` of the
model's context window (``model_budget.context_window``), the runtime runs ONE
tool-less compaction step before the next execution's model loop — or the user
asks for it from the palette (``POST /agent-tasks/{id}/compact``). The step
asks the active model to write a dense continuation summary of the replayed
turns, bounded and redacted, stores it on the task's typed context
(``task_context_versions.summary_sanitized`` + ``summary_through_seq``), and
the prompt builder then replays only the messages AFTER that point with the
summary in the stable half. The overflow fallback (``_CONTEXT_CUT_MARKER``)
stays as the last resort.

Same shape as the title step: one bounded streamed call on the per-run model
client, a private loop, a seam (``COMPACT_STEP``) for test doubles, never a
second Agent. Nothing raw enters the summary prompt — only the already
sanitized, bounded replay the model saw anyway. No chain-of-thought is kept.
"""

from __future__ import annotations

import asyncio
import sqlite3
from typing import Any

from ..repositories import sessions as sessions_repo
from ..security.redaction import redact_text
from ..task_runtime import context as task_context
from ..task_runtime import store
from . import model_budget
from .guardrails import strip_chain_of_thought

COMPACT_MARKER = "[[storage-agent:compact]]"
TRIGGER_RATIO = 0.8
MAX_SUMMARY_CHARS = 2000
STEP_TIMEOUT_S = 60.0
_MODEL_TIMEOUT_S = 45.0
_MAX_MESSAGES = 96
_MAX_MSG_CHARS = 3000
_MAX_PROMPT_CHARS = 48_000
# Rough size of the prompt that stays after compaction (instructions, skills
# catalog, providers, typed context) — the after_tokens figure is an ESTIMATE.
_BASE_PROMPT_TOKENS = 3000

INSTRUCTIONS = (
    "You compact an object-storage investigation so the same Agent can continue it "
    "with far less context. Write ONE dense continuation summary in Markdown, at most "
    f"{MAX_SUMMARY_CHARS - 200} characters: the goal; providers and buckets in focus; "
    "what was checked and what was found, with the numbers; evidence on hand and "
    "known gaps; open questions; what remains to do. State facts only — no "
    "reasoning narrative, no secrets, no raw rows, no preamble."
)


def sanitize_summary(raw: Any) -> str | None:
    text = str(raw or "")
    text = strip_chain_of_thought(redact_text(strip_chain_of_thought(text))).strip()
    if len(text) < 20:
        return None
    if len(text) > MAX_SUMMARY_CHARS:
        text = text[:MAX_SUMMARY_CHARS].rstrip()
    return text


def last_input_tokens(conn: sqlite3.Connection, task_id: str) -> int | None:
    """Reported input usage of the task's most recent model turn, or None when
    the endpoint did not report usage."""
    row = conn.execute(
        "SELECT input_tokens FROM turn_metrics WHERE session_id = ? "
        "ORDER BY created_at DESC, rowid DESC LIMIT 1", (task_id,)).fetchone()
    if row is None or row["input_tokens"] is None:
        return None
    return int(row["input_tokens"])


def should_compact(conn: sqlite3.Connection, task_id: str, creds: dict[str, Any] | None) -> bool:
    if not creds:
        return False
    tokens = last_input_tokens(conn, task_id)
    if tokens is None:
        return False
    window = model_budget.context_window(creds.get("model"), creds.get("context_window"))
    return tokens >= int(TRIGGER_RATIO * window)


def _replay(messages: list[dict[str, Any]], through_seq: int | None) -> list[dict[str, Any]]:
    """Only the messages a prior compaction has not already folded in."""
    if through_seq is None:
        return messages[-_MAX_MESSAGES:]
    return [m for m in messages if (m.get("seq") is None or int(m["seq"]) > through_seq)][-_MAX_MESSAGES:]


def build_prompt(messages: list[dict[str, Any]], prior_summary: str | None) -> str:
    parts: list[str] = [COMPACT_MARKER, "Compact this investigation."]
    if prior_summary:
        parts.append("Earlier summary (already compacted; fold it in):\n"
                     + redact_text(prior_summary)[:MAX_SUMMARY_CHARS])
    lines: list[str] = []
    total = 0
    for m in messages:
        role = "User" if m.get("role") == "user" else "Agent"
        body = redact_text(str(m.get("content") or ""))[:_MAX_MSG_CHARS]
        tools = [str(a.get("tool")) for a in (m.get("tool_activity") or [])
                 if isinstance(a, dict) and a.get("tool")][:20]
        line = f"{role}: {body}" + (f"\n  (tools run: {', '.join(tools)})" if tools else "")
        if total + len(line) > _MAX_PROMPT_CHARS:
            lines.append("[earlier turns omitted]")
            break
        lines.append(line)
        total += len(line)
    parts.append("Turns:\n" + "\n\n".join(lines))
    parts.append("Continuation summary:")
    return "\n\n".join(parts)


async def _ask_model(creds: dict[str, Any], prompt: str) -> str:
    from agents import Runner

    from .agent_service import build_agent
    from .session_agent import _close_clients
    clients: list[Any] = []
    try:
        agent = build_agent(creds, [], INSTRUCTIONS, name="Storage Agent",
                            max_tokens=900, temperature=0.0, include_usage=False,
                            client_registry=clients, model_timeout=_MODEL_TIMEOUT_S)
        result = Runner.run_streamed(agent, prompt, max_turns=1)
        async for _event in result.stream_events():
            pass
        return str(getattr(result, "final_output", "") or "")
    finally:
        await _close_clients(clients)


def generate_summary(creds: dict[str, Any], messages: list[dict[str, Any]],
                     prior_summary: str | None) -> str | None:
    """One bounded model call on a private loop; None on any failure."""
    loop = asyncio.new_event_loop()
    try:
        raw = loop.run_until_complete(
            asyncio.wait_for(_ask_model(creds, build_prompt(messages, prior_summary)),
                             timeout=STEP_TIMEOUT_S))
    except BaseException:  # noqa: BLE001 — compaction never fails a turn
        return None
    finally:
        try:
            pending = asyncio.all_tasks(loop)
            for t in pending:
                t.cancel()
            if pending:
                loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
            loop.run_until_complete(loop.shutdown_asyncgens())
        except Exception:  # noqa: BLE001
            pass
        loop.close()
    return sanitize_summary(raw)


# Seam: tests replace this with a fake that returns a summary (or None).
COMPACT_STEP = generate_summary


def estimate_tokens(text: str) -> int:
    return max(1, len(text) // 4)


def compact(conn: sqlite3.Connection, task_id: str, creds: dict[str, Any],
            execution_id: str | None,
            messages: list[dict[str, Any]] | None = None) -> dict[str, Any] | None:
    """The whole step: replay → model → sanitize → persist a context version
    carrying the summary. Returns the ``context.compacted`` payload (+ version),
    or None when there was nothing to compact or no usable summary came back.
    Never raises."""
    try:
        latest = store.latest_context(conn, task_id) or {}
        prior = latest.get("summary")
        through = latest.get("summary_through_seq")
        msgs = messages if messages is not None else \
            sessions_repo.list_messages(conn, task_id, limit=_MAX_MESSAGES)
        replay = _replay(msgs, through)
        if not replay:
            return None
        summary = sanitize_summary(COMPACT_STEP(creds, replay, prior))
        if not summary:
            return None
        last_seq = max((int(m["seq"]) for m in replay if m.get("seq") is not None),
                       default=None)
        doc = task_context.build_snapshot(conn, task_id)
        # The caller commits (the runtime through its next durable append, the
        # router explicitly): this step never owns the shared turn connection.
        version = store.save_context_summary(conn, task_id, doc, summary, last_seq,
                                             execution_id)
        before = last_input_tokens(conn, task_id)
        after = estimate_tokens(summary) + _BASE_PROMPT_TOKENS
        return {"before_tokens": before, "after_tokens": after,
                "summary_chars": len(summary), "version": version}
    except Exception:  # noqa: BLE001
        return None


def latest_summary(conn: sqlite3.Connection, task_id: str | None) -> dict[str, Any] | None:
    """``{summary, through_seq}`` for the prompt builder, or None."""
    if conn is None or not task_id:
        return None
    try:
        latest = store.latest_context(conn, task_id)
    except Exception:  # noqa: BLE001
        return None
    if not latest or not latest.get("summary"):
        return None
    return {"summary": latest["summary"], "through_seq": latest.get("summary_through_seq")}


__all__ = ["COMPACT_MARKER", "TRIGGER_RATIO", "MAX_SUMMARY_CHARS", "COMPACT_STEP",
           "should_compact", "compact", "latest_summary", "sanitize_summary",
           "build_prompt", "last_input_tokens", "estimate_tokens"]
