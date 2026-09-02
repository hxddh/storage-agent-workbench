"""Runtime task titles (v1.10.0).

A task starts with a deterministic seed title (the truncated first Direction).
After its FIRST Work Result the runtime asks the active model for a short
title from the Direction and the bounded Work Result text only — never tool
payloads, never evidence rows — sanitizes it, and stores it on the session
compatibility row with ``title_source = 'agent'``. A user rename sets
``title_source = 'user'`` and wins forever. When the model is unavailable, slow,
or answers with nothing usable, the seed title stays: the step never fails a
turn and never invents a title from anything but the model's answer.

This is one bounded tool-less call on the SAME per-run model client the
session Agent uses (``agent_service.build_agent``). It is not a second Agent.
Test doubles recognise the request by ``TITLE_MARKER`` in the prompt and answer
without consuming a scripted turn.
"""

from __future__ import annotations

import asyncio
import re
import sqlite3
from typing import Any

from ..repositories import sessions as sessions_repo
from ..security.redaction import redact_text
from . import store

TITLE_MARKER = "[[storage-agent:title]]"
MAX_WORDS = 8
MAX_CHARS = 64
# The whole step, including the client's own retries, is bounded here so the
# execution's terminal status is never held hostage by a stalled endpoint.
STEP_TIMEOUT_S = 15.0
_MODEL_TIMEOUT_S = 12.0
_DIRECTION_CHARS = 600
_ANSWER_CHARS = 1200

INSTRUCTIONS = (
    "You name object-storage engineering tasks. Reply with ONE short title only: "
    f"at most {MAX_WORDS} words, no quotes, no trailing period, no markdown, no "
    "explanation. Name the storage problem or goal, not the outcome."
)


def sanitize_title(raw: Any) -> str | None:
    """A bounded, single-line, redacted title — or None when nothing usable
    came back. Quotes, code fences, list markers and a trailing period are
    stripped; more than ``MAX_WORDS`` words is cut, not rejected."""
    text = str(raw or "")
    text = text.replace("`", "").replace("*", "").replace("#", "")
    text = text.strip().splitlines()[0].strip() if text.strip() else ""
    text = re.sub(r"^(?:title\s*:\s*)", "", text, flags=re.IGNORECASE)
    text = text.strip("\"'“”‘’ \t").rstrip(".。").strip()
    text = re.sub(r"^[-•\d]+[.)]?\s+", "", text)
    text = re.sub(r"\s+", " ", text)
    if not text:
        return None
    text = redact_text(text)
    words = text.split(" ")
    if len(words) > MAX_WORDS:
        text = " ".join(words[:MAX_WORDS])
    if len(text) > MAX_CHARS:
        text = text[:MAX_CHARS].rstrip()
    if len(text) < 3 or "http" in text.lower():
        return None
    return text


def should_title(conn: sqlite3.Connection, task_id: str) -> bool:
    """Only the first Work Result titles a task, and only while the title is
    still the deterministic seed (``title_source`` NULL)."""
    row = conn.execute("SELECT title_source FROM sessions WHERE id = ?", (task_id,)).fetchone()
    if row is None or row["title_source"]:
        return False
    n = conn.execute(
        "SELECT COUNT(*) FROM session_messages WHERE session_id = ? AND role = 'assistant'",
        (task_id,)).fetchone()[0]
    return int(n) == 1


def build_prompt(direction: str, answer: str) -> str:
    """The Direction and the bounded Work Result text, redacted. Nothing else
    from the turn (tool inputs/outputs, evidence) reaches this call."""
    d = redact_text(str(direction or ""))[:_DIRECTION_CHARS].strip()
    a = redact_text(str(answer or ""))[:_ANSWER_CHARS].strip()
    return (f"{TITLE_MARKER}\nName this task.\n\nDirection:\n{d}\n\n"
            f"Work result (excerpt):\n{a}\n\nTitle:")


async def _ask_model(creds: dict[str, Any], prompt: str) -> str:
    from ..agent_runtime.agent_service import build_agent
    from ..agent_runtime.session_agent import _close_clients
    from agents import Runner
    clients: list[Any] = []
    try:
        agent = build_agent(creds, [], INSTRUCTIONS, name="Storage Agent",
                            max_tokens=32, temperature=0.0, include_usage=False,
                            client_registry=clients, model_timeout=_MODEL_TIMEOUT_S)
        # Streamed like every other model call in the product: third-party
        # endpoints are exercised through streaming only, so the title step
        # must not be the one request that takes a different wire path.
        result = Runner.run_streamed(agent, prompt, max_turns=1)
        async for _event in result.stream_events():
            pass
        return str(getattr(result, "final_output", "") or "")
    finally:
        await _close_clients(clients)


def generate_title(creds: dict[str, Any], direction: str, answer: str) -> str | None:
    """One bounded model call on a private loop; None on any failure."""
    loop = asyncio.new_event_loop()
    try:
        raw = loop.run_until_complete(
            asyncio.wait_for(_ask_model(creds, build_prompt(direction, answer)),
                             timeout=STEP_TIMEOUT_S))
    except BaseException:  # noqa: BLE001 — the title step never fails a turn
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
    return sanitize_title(raw)


# Seam: tests replace this with a fake that returns a title (or None).
TITLE_STEP = generate_title


def apply_title(conn: sqlite3.Connection, task_id: str, title: str) -> None:
    """Persist an agent title on the compatibility row and the durable task row.
    Does nothing when the user renamed the task meanwhile (``user`` wins)."""
    cur = conn.execute(
        "UPDATE sessions SET title = ?, title_source = 'agent' WHERE id = ? "
        "AND (title_source IS NULL OR title_source = 'agent')",
        (redact_text(title), task_id))
    if cur.rowcount > 0:
        store.sync_task_identity(conn, task_id, title=title)


def run_title_step(conn: sqlite3.Connection, task_id: str, direction: str, answer: str,
                   creds: dict[str, Any] | None) -> str | None:
    """The whole step: gate → model → sanitize → persist. Returns the applied
    title, or None when the seed title was kept. Never raises."""
    try:
        if not creds or not should_title(conn, task_id):
            return None
        # Sanitized here regardless of what the seam returned: the bound and
        # the redaction are the runtime's, not the model's or a test double's.
        title = sanitize_title(TITLE_STEP(creds, direction, answer))
        if not title:
            return None
        if sessions_repo.title_for(conn, task_id) == title:
            return None
        apply_title(conn, task_id, title)
        return title
    except Exception:  # noqa: BLE001
        return None
