"""The single writer of a turn's items (v5).

Every durable fact of a turn goes through here: the Direction, commentary and
the answer (as closed segments), tool calls and their outputs, throttled
progress, the conclusion, steers, notices. Each append is published to the
hub so open streams update the moment it lands; live text deltas go to the
hub only and are written once, whole, when the segment closes.

Subscribers (``on_tool_output``) let deterministic projections — the estate —
react to tool results without the tools knowing about them.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationError, model_validator

from .. import db
from ..core import hub, store
from ..security.redaction import redact, redact_text
from . import safety

_UI_DETAIL_CHARS = 24_000
_PROGRESS_MIN_INTERVAL_S = 1.0
_PROGRESS_MAX_PER_CALL = 120

ToolOutputHook = Callable[[dict[str, Any]], None]
_hooks: list[ToolOutputHook] = []


def on_tool_output(hook: ToolOutputHook) -> ToolOutputHook:
    """Register a projection that sees every finished tool call:
    {task_id, turn_id, tool, args, ok, result}. Hooks must never raise."""
    _hooks.append(hook)
    return hook


class Finding(BaseModel):
    title: str = Field(min_length=1, max_length=240)
    severity: Literal["high", "medium", "low", "info"]
    detail: str | None = Field(default=None, max_length=600)


class Conclusion(BaseModel):
    """v9: findings and/or next steps. The answer is the Turn's final message;
    items recorded before v9 may still carry an ``answer`` (read, never written)."""
    findings: list[Finding] = Field(default_factory=list, max_length=8)
    next_steps: list[str] = Field(default_factory=list, max_length=4)

    @model_validator(mode="before")
    @classmethod
    def _nulls_are_empty(cls, data: Any) -> Any:
        if isinstance(data, dict):
            data = {**data, **{k: [] for k in ("findings", "next_steps") if data.get(k) is None}}
        return data

    @model_validator(mode="after")
    def _not_empty(self) -> Conclusion:
        if not self.findings and not self.next_steps:
            raise ValueError("a conclusion needs at least one finding or next step")
        return self


class Recorder:
    def __init__(self, task_id: str, turn_id: str) -> None:
        self.task_id = task_id
        self.turn_id = turn_id
        self._lock = threading.RLock()
        self._conn = db.connect()
        self._open: dict[str, Any] | None = None  # the segment being written
        self._progress: dict[str, tuple[float, int]] = {}
        self._calls: dict[str, dict[str, Any]] = {}
        self._produced = False  # any model output (text or a tool call) this Turn
        self._closed = False

    def close(self) -> None:
        with self._lock:
            self._closed = True
            try:
                self._conn.close()
            except Exception:  # noqa: BLE001
                pass

    # -- the one append --------------------------------------------------------------
    def _append(self, type_: str, payload: dict[str, Any], *, item_id: str | None = None) -> dict[str, Any]:
        with self._lock:
            if self._closed:
                # A tool thread that outlived its Stop or timeout: the turn's record is closed.
                return {}
            item = store.append_item(self._conn, self.task_id, self.turn_id, type_, payload, item_id=item_id)
            if type_ in ("agent_message", "tool_call", "conclusion"):
                self._produced = True
        hub.item(self.task_id, item)
        return item

    def has_output(self) -> bool:
        """Whether the model produced anything this Turn (so a transport retry would repeat it)."""
        with self._lock:
            return self._produced or self._open is not None

    def notice(self, event: str, **fields: Any) -> dict[str, Any]:
        return self._append("notice", {"event": event, **fields})

    def user_message(self, text: str, attachments: list[dict[str, Any]] | None = None) -> None:
        payload: dict[str, Any] = {"text": redact_text(text)}
        if attachments:
            payload["attachments"] = attachments
        self._append("user_message", payload)

    def steer(self, text: str) -> None:
        self.close_segment()
        self._append("steer", {"text": redact_text(text)})

    # -- model text --------------------------------------------------------------------
    def delta(self, text: str) -> None:
        if not text:
            return
        with self._lock:
            if self._open is None:
                self._open = {"id": store.new_id(), "raw": "", "sanitizer": safety.StreamSanitizer()}
            seg = self._open
            seg["raw"] += text
            visible = seg["sanitizer"].push(seg["raw"])
        if visible:
            hub.delta(self.task_id, self.turn_id, seg["id"], visible)

    def close_segment(self) -> str | None:
        """Close the open segment at a message boundary and persist it whole."""
        with self._lock:
            seg, self._open = self._open, None
        if seg is None:
            return None
        text = safety.clean_message(seg["raw"])
        hub.close_segment(self.task_id, seg["id"])
        if not text:
            return None
        self._append("agent_message", {"text": text}, item_id=seg["id"])
        return text

    # -- tools -------------------------------------------------------------------------
    def tool_started(self, call_id: str, name: str, args: dict[str, Any], target: str) -> None:
        self.close_segment()
        self._calls[call_id] = {"name": name, "args": args, "started": time.monotonic()}
        self._append("tool_call", {"call_id": call_id, "name": name, "args": args, "target": target})

    def tool_refused(self, call_id: str, name: str, args: dict[str, Any], reason: str) -> None:
        self.tool_started(call_id, name, args, str(args.get("bucket") or args.get("provider_id") or ""))
        self._append("tool_output", {"call_id": call_id, "name": name, "ok": False, "refused": True,
                                     "summary": redact_text(reason)[:240],
                                     "model_output": f"Refused: {redact_text(reason)}"})
        store.audit(self._conn, actor="agent", action=f"tool.{name}", task_id=self.task_id,
                    target=str(args.get("bucket") or ""), ok=False, detail={"refused": reason})

    def tool_finished(self, call_id: str, name: str, ok: bool, summary: str, result: Any,
                      duration_ms: int, model_text: str | None = None) -> None:
        """``model_text`` is exactly what the model read (bounded, enveloped); it is
        what a later turn replays, so the history never loses the envelope."""
        call = self._calls.pop(call_id, {"args": {}})
        detail = None
        model_output = model_text
        if result is not None:
            text = result if isinstance(result, str) else _json(result)
            if model_output is None:
                model_output = text[:60_000]
            detail = text[:_UI_DETAIL_CHARS]
        self._append("tool_output", {"call_id": call_id, "name": name, "ok": ok, "summary": summary,
                                     "duration_ms": duration_ms, "detail": detail,
                                     "detail_truncated": bool(detail and model_output and len(model_output) > len(detail)),
                                     "model_output": model_output})
        store.audit(self._conn, actor="agent", action=f"tool.{name}", task_id=self.task_id,
                    target=str(call.get("args", {}).get("bucket") or call.get("args", {}).get("provider_id") or ""),
                    ok=ok, duration_ms=duration_ms, detail={"args": call.get("args"), "summary": summary})
        if result is not None:
            event = {"task_id": self.task_id, "turn_id": self.turn_id, "tool": name,
                     "args": call.get("args", {}), "ok": ok, "result": result}
            for hook in list(_hooks):
                try:
                    hook(event)
                except Exception:  # noqa: BLE001 — a projection never fails a call
                    pass

    def progress(self, call_id: str, name: str, done: int, total: int, unit: str) -> None:
        if call_id not in self._calls:
            return  # the call already settled (stopped or timed out): no progress after its output
        now = time.monotonic()
        last_at, count = self._progress.get(call_id, (0.0, 0))
        final = total > 0 and done >= total
        if not final and (now - last_at < _PROGRESS_MIN_INTERVAL_S or count >= _PROGRESS_MAX_PER_CALL):
            return
        self._progress[call_id] = (now, count + 1)
        self._append("tool_progress", {"call_id": call_id, "name": name, "done": int(done),
                                       "total": int(total), "unit": unit[:24]})

    def conclusion(self, call_id: str, args: dict[str, Any]) -> str:
        self.close_segment()
        try:
            c = Conclusion.model_validate(args)
        except ValidationError as exc:
            return f"Not recorded: {redact_text(str(exc))[:400]}. Fix the fields and call again."
        data = redact({
            "findings": [{"title": f.title, "severity": f.severity,
                          **({"detail": f.detail} if f.detail else {})} for f in c.findings],
            "next_steps": [s[:200] for s in c.next_steps],
        })
        self._append("conclusion", {"call_id": call_id, **data})
        return "Conclusion recorded."


def _json(value: Any) -> str:
    import json
    return json.dumps(value, separators=(",", ":"), default=str, ensure_ascii=False)
