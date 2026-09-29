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


def history_items(conn, task_id: str, before_turn_id: str | None) -> list[dict[str, Any]]:
    """Input items for everything on the branch before ``before_turn_id``
    (or the whole branch when it is None), compaction-aware."""
    chain = store.branch(conn, task_id, before_turn_id)
    turn_ids = [t["id"] for t in chain if t["id"] != before_turn_id]
    items = store.items_for_turns(conn, turn_ids)
    return to_input(items)


def to_input(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
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
    open_calls: dict[str, dict[str, Any]] = {}
    for it in items:
        if it["type"] == "compaction" or it.get("turn_id") in folded:
            continue
        p = it["payload"]
        t = it["type"]
        if t == "user_message":
            text = p.get("text", "")
            if p.get("attachments"):
                names = ", ".join(a.get("filename", "") for a in p["attachments"])
                text += f"\n[Attached: {names} — see list_uploaded_files]"
            out.append({"role": "user", "content": text})
        elif t == "steer":
            out.append({"role": "user", "content": "[The user steered while you worked] " + p.get("text", "")})
        elif t == "agent_message":
            out.append({"role": "assistant", "content": p.get("text", "")})
        elif t == "tool_call":
            call = {"type": "function_call", "call_id": p["call_id"], "name": p["name"],
                    "arguments": json.dumps(p.get("args") or {}, separators=(",", ":"))}
            out.append(call)
            open_calls[p["call_id"]] = call
        elif t == "tool_output":
            if p["call_id"] in open_calls:
                open_calls.pop(p["call_id"])
                out.append({"type": "function_call_output", "call_id": p["call_id"],
                            "output": p.get("model_output") or p.get("summary") or ""})
        elif t == "conclusion":
            out.append({"type": "function_call", "call_id": p["call_id"], "name": "record_conclusion",
                        "arguments": json.dumps({k: p.get(k) for k in ("answer", "findings", "next_steps")},
                                                separators=(",", ":"))})
            out.append({"type": "function_call_output", "call_id": p["call_id"], "output": "Conclusion recorded."})
        elif t == "notice" and p.get("event") == "resumed":
            out.append({"role": "user", "content": p.get("note") or "[Continue the interrupted work.]"})
    # A call without an output (a crash mid-call) still needs one: providers
    # reject a dangling function_call.
    if open_calls:
        fixed: list[dict[str, Any]] = []
        for entry in out:
            fixed.append(entry)
            if entry.get("type") == "function_call" and entry["call_id"] in open_calls:
                fixed.append({"type": "function_call_output", "call_id": entry["call_id"],
                              "output": _INTERRUPTED_OUTPUT})
        out = fixed
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
        out = to_input(items)
        return out[-limit:] if limit else out

    async def add_items(self, items: list[Any]) -> None:
        return None  # the Recorder is the only writer

    async def pop_item(self) -> Any:
        return None

    async def clear_session(self) -> None:
        return None
