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

_INTERRUPTED_OUTPUT = "[No result: the work was interrupted before this call returned.]"


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
                names = ", ".join(a.get("filename", "") for a in p["attachments"])
                text += f"\n[Attached: {names} — see list_uploaded_files]"
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
