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

import logging
import sqlite3
import threading
import time
from collections.abc import Callable
from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationError, model_validator

from .. import db
from ..core import hub, store
from ..security.redaction import scrub_text, scrub_value
from . import safety

_UI_DETAIL_CHARS = 24_000
# A later Turn does not need the full deterministic table to reason about the
# conversation: the Task keeps it for the reader, and query_estate/inspect_*
# can retrieve any row again. This is the model-facing replay budget only.
_MODEL_HISTORY_CHARS = 4_000
_PROGRESS_MIN_INTERVAL_S = 1.0
_PROGRESS_MAX_PER_CALL = 120
_EVIDENCE_EXCLUDE = {"record_conclusion", "read_skill", "note"}

ToolOutputHook = Callable[[dict[str, Any]], None]
_hooks: list[ToolOutputHook] = []
logger = logging.getLogger(__name__)


def on_tool_output(hook: ToolOutputHook) -> ToolOutputHook:
    """Register a projection that sees every finished tool call:
    {task_id, turn_id, tool, args, ok, result}. Hooks must never raise."""
    _hooks.append(hook)
    return hook


def _history_digest(name: str, result: Any, summary: str) -> str | None:
    """A compact, replay-only tool result for large deterministic outputs.

    The current Turn still reads the complete result; this is what later Turns
    see instead of a full survey table. It names the facts needed to continue
    the conversation and points back to the tool for detail. The envelope is
    preserved because the digest is still third-party data.
    """
    if not isinstance(result, dict):
        return None
    doc: dict[str, Any]
    if name == "survey_account" and isinstance(result.get("buckets"), dict):
        table = result["buckets"]
        rows = table.get("rows") if isinstance(table.get("rows"), list) else []
        doc = {
            "success": result.get("success"),
            "issues": (result.get("issues") or [])[:12],
            "coverage": result.get("coverage") or {},
            "estate_changes": result.get("estate_changes"),
            "buckets": {
                "count": len(rows) + int(table.get("rows_omitted") or 0),
                "columns": table.get("columns") or [],
                "rows_omitted": int(table.get("rows_omitted") or 0),
            },
            "note": "Full bucket rows stay in the Task. Use query_estate or a narrower tool for a row.",
        }
    elif name == "query_estate":
        buckets = result.get("buckets") if isinstance(result.get("buckets"), list) else []
        issues = result.get("issues") if isinstance(result.get("issues"), list) else []
        doc = {
            "success": result.get("success"),
            "bucket_count": result.get("bucket_count", len(buckets)),
            "buckets": [str(b.get("bucket") or b.get("name") or "") for b in buckets[:80] if isinstance(b, dict)],
            "issues": issues[:40],
            "notes": result.get("notes") or [],
            "issue_events": result.get("issue_events") or [],
            "note": "Bucket names and issue rows are summarized for later turns; query again for full detail.",
        }
    elif name == "list_buckets":
        buckets = result.get("buckets") if isinstance(result.get("buckets"), list) else []
        doc = {"success": result.get("success"), "buckets": [
            str(b.get("bucket") or b.get("name") or "") for b in buckets[:120] if isinstance(b, dict)]}
    elif name == "review_bucket_config":
        sections = result.get("sections")
        doc = {
            "success": result.get("success"), "bucket": result.get("bucket"),
            "findings": result.get("findings") or [],
            "sections": list(sections) if isinstance(sections, dict) else [],
            "note": "Configuration values are in the Task; inspect the bucket again for a full value.",
        }
    else:
        # Unknown large payloads: retain the summary and an honest pointer,
        # never a silently partial JSON object.
        doc = {"summary": summary, "note": "The complete result stays in the Task; call the tool again for detail."}
    raw = _json(doc)
    # Keep the replay a valid JSON document: trim the lists, never cut inside
    # the JSON text. The Task still has every row.
    for key in ("issues", "buckets", "notes", "issue_events"):
        while len(safety.envelope(raw)) > _MODEL_HISTORY_CHARS and isinstance(doc.get(key), list) and doc[key]:
            doc[key] = doc[key][: max(0, len(doc[key]) // 2)]
            raw = _json(doc)
    if len(safety.envelope(raw)) > _MODEL_HISTORY_CHARS:
        raw = _json({"summary": summary, "note": "The complete result stays in the Task; call the tool again."})
    return safety.envelope(raw)


class Finding(BaseModel):
    title: str = Field(min_length=1, max_length=240)
    severity: Literal["high", "medium", "low", "info"]
    detail: str | None = Field(default=None, max_length=600)


class Conclusion(BaseModel):
    """The Turn's findings. The answer is the Turn's final message."""
    findings: list[Finding] = Field(default_factory=list, max_length=8)

    @model_validator(mode="before")
    @classmethod
    def _nulls_are_empty(cls, data: Any) -> Any:
        if isinstance(data, dict) and data.get("findings") is None:
            data = {**data, "findings": []}
        return data

    @model_validator(mode="after")
    def _not_empty(self) -> Conclusion:
        if not self.findings:
            raise ValueError("a conclusion needs at least one finding")
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
        # Successful calls are the Turn's evidence. It is attached to the
        # conclusion deterministically — the model never names its own proof.
        self._evidence: list[dict[str, Any]] = []
        self._produced = False  # any model output (text or a tool call) this Turn
        self._closed = False
        self.last_message = ""  # the latest agent_message of this Turn (its answer when it ends)

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
            # The last boundary before anything durable: every item payload —
            # including tool targets and model-visible output — is scrubbed of
            # exact vault values and credential shapes, not just the fields
            # whose callers remembered to clean.
            payload = scrub_value(payload)
            try:
                item = store.append_item(self._conn, self.task_id, self.turn_id, type_, payload, item_id=item_id)
            except sqlite3.IntegrityError:
                # The Task was deleted under a Turn that was still unwinding.
                # Its rows are gone with it (ON DELETE CASCADE), so there is
                # nothing left to record. Roll back — a failed INSERT can leave
                # a write transaction open — and stop writing for this Turn. If
                # we let this escape, the runtime's cleanup would be skipped and
                # the open transaction would lock every later write.
                self._conn.rollback()
                self._closed = True
                logger.info("task %s was deleted while turn %s was running", self.task_id, self.turn_id)
                return {}
            if type_ in ("agent_message", "tool_call", "conclusion"):
                self._produced = True
            if type_ == "agent_message":
                self.last_message = str(payload.get("text") or "")
            # Publish while the append lock is still held. Publishing outside it
            # lets two parallel tool threads land seq+1 before seq; the SSE
            # follower advances its cursor on the first one and then drops the
            # earlier durable item as "already seen".
            hub.item(self.task_id, item)
        return item

    def has_output(self) -> bool:
        """Whether the model produced anything this Turn (so a transport retry would repeat it)."""
        with self._lock:
            return self._produced or self._open is not None

    def notice(self, event: str, **fields: Any) -> dict[str, Any]:
        return self._append("notice", {"event": event, **fields})

    def user_message(self, text: str, attachments: list[dict[str, Any]] | None = None) -> None:
        # A Direction is replayed to the model, saved in SQLite and quoted in the
        # report. Pattern redaction alone is not enough for a configured secret
        # with a provider-specific shape, so the exact vault values are masked
        # here too.
        payload: dict[str, Any] = {"text": scrub_text(text)}
        if attachments:
            payload["attachments"] = scrub_value(attachments)
        self._append("user_message", payload)

    def steer(self, text: str) -> None:
        self.close_segment()
        self._append("steer", {"text": scrub_text(text)})

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
        safe = scrub_value(args)
        self._calls[call_id] = {"name": name, "args": safe, "target": target, "started": time.monotonic()}
        self._append("tool_call", {"call_id": call_id, "name": name, "args": safe, "target": target})

    def tool_refused(self, call_id: str, name: str, args: dict[str, Any], reason: str) -> None:
        from .tools.registry import tidy_summary
        safe = scrub_value(args)
        clean_reason = scrub_text(reason)
        self.tool_started(call_id, name, safe, str(safe.get("bucket") or safe.get("provider_id") or ""))
        self._append("tool_output", {"call_id": call_id, "name": name, "ok": False, "refused": True,
                                     "summary": tidy_summary(clean_reason),
                                     "model_output": f"Refused: {clean_reason}"})
        store.audit(self._conn, actor="agent", action=f"tool.{name}", task_id=self.task_id,
                    target=str(safe.get("bucket") or ""), ok=False, detail={"refused": clean_reason})

    def tool_skipped(self, call_id: str, name: str, args: dict[str, Any], target: str, *, ok: bool,
                     summary: str, model_text: str) -> None:
        """A call the runtime answered without running it (a repeat of a call this
        Turn already made, arguments that were not JSON): recorded and audited
        like any other call, so the stream and the audit stay complete."""
        safe = scrub_value(args)
        self.tool_started(call_id, name, safe, target)
        self._calls.pop(call_id, None)
        clean_summary = scrub_text(summary)
        self._append("tool_output", {"call_id": call_id, "name": name, "ok": ok, "summary": clean_summary,
                                     "duration_ms": 0, "detail": None, "model_output": model_text})
        store.audit(self._conn, actor="agent", action=f"tool.{name}", task_id=self.task_id, target=target[:200],
                    ok=ok, duration_ms=0, detail={"args": safe, "summary": clean_summary, "skipped": True})

    def tool_finished(self, call_id: str, name: str, ok: bool, summary: str, result: Any,
                      duration_ms: int, model_text: str | None = None) -> None:
        """``model_text`` is exactly what the model read (bounded, enveloped); it is
        what a later turn replays, so the history never loses the envelope."""
        call = self._calls.pop(call_id, {"args": {}})
        detail = None
        model_output = model_text
        clean_summary = scrub_text(summary)
        if result is not None:
            clean = scrub_value(result)
            text = clean if isinstance(clean, str) else _json(clean)
            if model_output is None:
                model_output = text[:60_000]
            # Keep the full deterministic result for the window, but let later
            # Turns replay a digest. This is the main token-cost reduction for
            # follow-ups: the current Turn still sees what it actually read.
            if model_output and len(model_output) > _MODEL_HISTORY_CHARS:
                model_output = _history_digest(name, clean, clean_summary) or model_output
            detail = text[:_UI_DETAIL_CHARS]
        # `detail_truncated` is about the UI copy, not about how long the model's
        # enveloped output was: a complete JSON result must still render as a
        # table when `model_output` happens to be longer than the 24k UI copy.
        self._append("tool_output", {"call_id": call_id, "name": name, "ok": ok, "summary": clean_summary,
                                     "duration_ms": duration_ms, "detail": detail,
                                     "detail_truncated": bool(detail and len(text) > _UI_DETAIL_CHARS),
                                     "model_output": model_output})
        store.audit(self._conn, actor="agent", action=f"tool.{name}", task_id=self.task_id,
                    target=str(call.get("args", {}).get("bucket") or call.get("args", {}).get("provider_id") or ""),
                    ok=ok, duration_ms=duration_ms, detail={"args": call.get("args"), "summary": clean_summary})
        if ok and name not in _EVIDENCE_EXCLUDE:
            self._evidence.append({"call_id": call_id, "name": name,
                                   "target": str(call.get("target") or "")[:200],
                                   "summary": clean_summary})
        if result is not None:
            event = {"task_id": self.task_id, "turn_id": self.turn_id, "tool": name,
                     "args": call.get("args", {}), "ok": ok, "result": clean}
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
            return f"Not recorded: {scrub_text(str(exc))[:400]}. Fix the fields and call again."
        data = scrub_value({
            "findings": [{"title": f.title, "severity": f.severity,
                          **({"detail": f.detail} if f.detail else {})} for f in c.findings],
        })
        # Turn-level evidence: the successful calls this Turn actually made,
        # most recent eight. The surface calls them "checks in this turn", never
        # proof of one finding.
        if self._evidence:
            data["evidence"] = scrub_value(self._evidence[-8:])
        self._append("conclusion", {"call_id": call_id, **data})
        return "Conclusion recorded."


def _json(value: Any) -> str:
    import json
    return json.dumps(value, separators=(",", ":"), default=str, ensure_ascii=False)
