"""The Agents SDK ``Session`` over the item stream (v5).

History is not re-assembled from summaries and JSON context blocks: the model
sees the branch's real items — the user's Directions and steers, its own
messages, its function calls and their outputs — as proper Responses input
items. That is what makes a continuation after a restart native: the
interrupted turn's completed calls are already in the history, so the model
picks up where it stopped instead of reading a digest.

Writes go through the ``Recorder``, so ``add_items`` is a no-op: the SDK's
bookkeeping never duplicates what the runtime already recorded.
"""

from __future__ import annotations

import json
from typing import Any

from .. import db
from ..core import store
from . import safety

_INTERRUPTED_OUTPUT = "[No result: the work was interrupted before this call returned.]"
_ITEM_OVERHEAD_CHARS = 16  # role / type / ids around each item's text
PREVIEW_CHARS = 300
TRIMMED_MARK = "[earlier output trimmed: "
_OMITTED = "[Earlier history omitted to fit the model's context window.]"


def _assistant(item_id: str, text: str) -> dict[str, Any]:
    # The SDK's own output-message shape: on Chat Completions its converter
    # merges this message with the tool calls that follow it into ONE assistant
    # message (a bare {"role": "assistant"} would be flushed on its own, and
    # strict chat templates reject two assistant messages in a row).
    return {"type": "message", "role": "assistant", "id": item_id or "msg", "status": "completed",
            "content": [{"type": "output_text", "text": text, "annotations": []}]}


def to_input(items: list[dict[str, Any]], *, skip_steers_of: str | None = None) -> list[dict[str, Any]]:
    """Items of one branch (in branch order) → model input.

    Tool calls of one model response are replayed as one batch — every call,
    then every output in call order — whatever order the recorder wrote them in
    (a conclusion or a refused call records its output at once). A call that
    never returned gets an "interrupted" output: providers reject a dangling
    call. ``skip_steers_of``: the running turn, whose steers the model-input
    filter injects itself.
    """
    # Only the latest compaction counts: it stands in for the turns it folded
    # (earlier summaries are folded into it), and comes first.
    folded: set[str] = set()
    summary: str | None = None
    for it in items:
        if it["type"] == "compaction":
            folded = set(it["payload"].get("folded") or [])
            summary = it["payload"].get("summary")
    out: list[dict[str, Any]] = []
    if summary:
        out.append({"role": "user", "content": "[Summary of the earlier work in this task]\n" + summary})

    calls: list[dict[str, Any]] = []          # the open batch, in call order
    outputs: dict[str, dict[str, Any]] = {}   # call_id -> its output item
    held: list[dict[str, Any]] = []           # steers that arrived while the batch was running

    # Steers the runtime carried into the next Direction are read there, not twice.
    carried: dict[str, int] = {}
    for it in items:
        if it["type"] == "notice" and it["payload"].get("event") == "carried":
            carried[it.get("turn_id", "")] = int(it["payload"].get("steers") or 0)
    steer_total: dict[str, int] = {}
    for it in items:
        if it["type"] == "steer":
            steer_total[it.get("turn_id", "")] = steer_total.get(it.get("turn_id", ""), 0) + 1
    steer_seen: dict[str, int] = {}

    def flush() -> None:
        if not calls:
            return
        out.extend(calls)
        for c in calls:
            out.append(outputs.get(c["call_id"]) or
                       {"type": "function_call_output", "call_id": c["call_id"], "output": _INTERRUPTED_OUTPUT})
        calls.clear()
        outputs.clear()
        out.extend(held)
        held.clear()

    def add_call(call: dict[str, Any]) -> None:
        # A new call after every call of the batch has returned starts a new response.
        if calls and all(c["call_id"] in outputs for c in calls):
            flush()
        calls.append(call)

    for it in items:
        if it["type"] == "compaction" or it.get("turn_id") in folded:
            continue
        p = it["payload"]
        t = it["type"]
        if t == "user_message":
            flush()
            text = p.get("text", "")
            if p.get("attachments"):
                # One line per file, with the id analyze_uploaded_file takes (no lookup step for a small model).
                for a in p["attachments"]:
                    text += (f"\n[Attached: {a.get('filename', '')} · dataset_id={a.get('dataset_id', '')}"
                             f" · kind={a.get('type', '')}]")
            out.append({"role": "user", "content": text})
        elif t == "steer":
            tid = it.get("turn_id", "")
            steer_seen[tid] = steer_seen.get(tid, 0) + 1
            if skip_steers_of and tid == skip_steers_of:
                continue
            if steer_seen[tid] > steer_total[tid] - carried.get(tid, 0):
                continue
            msg = {"role": "user", "content": "[The user steered while you worked] " + p.get("text", "")}
            if calls and not all(c["call_id"] in outputs for c in calls):
                held.append(msg)  # a tool still running: its result comes first
            else:
                flush()
                out.append(msg)
        elif t == "agent_message":
            flush()
            if p.get("text"):
                out.append(_assistant(it.get("id", ""), p["text"]))
        elif t == "tool_call":
            add_call({"type": "function_call", "call_id": p["call_id"], "name": p["name"],
                      "arguments": json.dumps(p.get("args") or {}, separators=(",", ":"))})
        elif t == "tool_output":
            if any(c["call_id"] == p["call_id"] for c in calls):
                outputs[p["call_id"]] = {"type": "function_call_output", "call_id": p["call_id"],
                                         "output": p.get("model_output") or p.get("summary") or ""}
        elif t == "conclusion":
            add_call({"type": "function_call", "call_id": p["call_id"], "name": "record_conclusion",
                      # The call as the v9 tool takes it; a pre-v9 item's `answer`
                      # is its Turn's final message, which replays on its own.
                      "arguments": json.dumps({k: p[k] for k in ("findings", "next_steps") if p.get(k)},
                                              separators=(",", ":"))})
            outputs[p["call_id"]] = {"type": "function_call_output", "call_id": p["call_id"],
                                     "output": "Conclusion recorded."}
        elif t == "notice" and p.get("event") == "resumed":
            flush()
            out.append({"role": "user", "content": p.get("note") or "[Continue the interrupted work.]"})
    flush()
    return out


# --- sizing and fitting model input (v10) ----------------------------------------------
# Sizes are characters of model-facing text; ``budget.est_tokens`` turns them
# into the one conservative token estimate.


def item_chars(item: Any) -> int:
    """The model-facing text of one input item (plus a small fixed overhead)."""
    if not isinstance(item, dict):
        return _ITEM_OVERHEAD_CHARS + len(str(item))
    n = _ITEM_OVERHEAD_CHARS
    for key in ("content", "output", "arguments", "name"):
        v = item.get(key)
        if isinstance(v, str):
            n += len(v)
        elif isinstance(v, list):
            n += sum(len(str(p.get("text") or "")) if isinstance(p, dict) else len(str(p)) for p in v)
    return n


def input_chars(items: list[Any]) -> int:
    return sum(item_chars(i) for i in items)


def preview_output(text: str, n: int = PREVIEW_CHARS) -> str:
    """An earlier tool output shrunk to its first ``n`` characters. Enveloped
    data stays enveloped: the preview is re-wrapped, never left open."""
    text = str(text or "")
    enveloped = text.startswith(safety.UNTRUSTED_OPEN)
    inner = text
    if enveloped:
        inner = text[len(safety.UNTRUSTED_OPEN):]
        if inner.endswith(safety.UNTRUSTED_CLOSE):
            inner = inner[:-len(safety.UNTRUSTED_CLOSE)]
        inner = inner.strip()
    head = inner[:n] + "…"
    return TRIMMED_MARK + (safety.envelope(head) if enveloped else head) + "]"


def _trailing_outputs(items: list[Any]) -> int:
    """Index where the trailing run of tool outputs (the latest batch) starts."""
    i = len(items)
    while i > 0 and isinstance(items[i - 1], dict) and items[i - 1].get("type") == "function_call_output":
        i -= 1
    return i


def shrink_outputs(items: list[Any], budget_chars: int, *, keep_latest: bool = True,
                   preview: int = PREVIEW_CHARS) -> tuple[list[Any], int]:
    """Shrink tool outputs, oldest first, to previews until the input fits
    ``budget_chars``. ``keep_latest``: the latest batch of outputs (what the
    model is about to read) stays whole. Returns (items, outputs shrunk)."""
    total = input_chars(items)
    if total <= budget_chars:
        return items, 0
    out = list(items)
    stop = _trailing_outputs(out) if keep_latest else len(out)
    shrunk = 0
    for n in range(stop):
        it = out[n]
        if not (isinstance(it, dict) and it.get("type") == "function_call_output"):
            continue
        text = it.get("output")
        if not isinstance(text, str) or text.startswith(TRIMMED_MARK) or len(text) <= preview + 120:
            continue
        small = preview_output(text, preview)
        total -= len(text) - len(small)
        out[n] = {**it, "output": small}
        shrunk += 1
        if total <= budget_chars:
            break
    return out, shrunk


def fit(items: list[Any], budget_chars: int) -> list[Any]:
    """History for a tool-less side step (a summary, a final answer) within
    ``budget_chars``: every tool output shrinks to a preview first; if that is
    not enough, the oldest items go (never leaving a tool output without its
    call) and a note says so."""
    out, _ = shrink_outputs(items, budget_chars, keep_latest=False)
    if input_chars(out) <= budget_chars:
        return out
    last = out[-1] if out else None
    while out and input_chars(out) + len(_OMITTED) > budget_chars:
        out.pop(0)
        # A call or output at the front has lost its partner: drop to the next message.
        while out and isinstance(out[0], dict) and out[0].get("type") in ("function_call", "function_call_output"):
            out.pop(0)
    if not out and isinstance(last, dict) and isinstance(last.get("content"), str):
        # Even the latest message alone is too long: keep its start.
        out = [{**last, "content": last["content"][: max(0, budget_chars - len(_OMITTED) - 64)]}]
    return [{"role": "user", "content": _OMITTED}, *out]


class ItemsSession:
    """SDK Session protocol backed by the item stream of one branch."""

    session_settings = None

    def __init__(self, task_id: str, turn_id: str) -> None:
        self.session_id = task_id
        self._turn_id = turn_id

    async def get_items(self, limit: int | None = None) -> list[dict[str, Any]]:
        conn = db.connect()
        try:
            # The current turn's own items too: a continuation replays its
            # completed calls; a fresh turn has only its Direction.
            chain = store.branch(conn, self.session_id, self._turn_id)
            items = store.items_for_turns(conn, [t["id"] for t in chain])
        finally:
            conn.close()
        # This turn's steers reach the model through the input filter, once.
        out = to_input(items, skip_steers_of=self._turn_id)
        return out[-limit:] if limit else out

    async def add_items(self, items: list[Any]) -> None:
        return None  # the Recorder is the only writer

    async def pop_item(self) -> Any:
        return None

    async def clear_session(self) -> None:
        return None
