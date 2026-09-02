"""Per-segment sanitized streaming over the SDK run: deltas, tool rows, segments, final."""

from __future__ import annotations

import re
from typing import Any

from ..security.redaction import REDACTED, redact_text
from .guardrails import strip_chain_of_thought_stream

from .limits import (_BUDGET_CUT_MARKER, _CONTEXT_CUT_MARKER, _STOPPED_MARKER, _STREAM_TAIL_HOLDBACK, _TRANSIENT_CUT_MARKER)
from .usage import (_is_cache_retention_rejection, _is_stream_options_rejection, _usage_snapshot)
from .finalize import (_FINALIZE_FALLBACK, _finalize_contract, _is_context_overflow,
                       _is_max_turns, _is_model_timeout, _is_tool_call_sequence_error,
                       _is_transient_provider_error, sanitize_answer_text)

_SECRET_TOKEN_TAIL = re.compile(r"[A-Za-z0-9/+=_.\-]{20,}\Z")
# Stream-only eager bare-SK rule: the precise pair rule in redaction.py masks a
# bare 40-char secret only when the AKIA/ASIA… key-id hint is present — but in
# a LIVE stream the model may echo the SK first and mention the key id 100s of
# chars later, after the SK already left over SSE. The live view masks every
# standalone 40-char base64ish token unconditionally; the persisted final
# answer applies the precise rules and corrects any over-redaction (that
# replace-on-finalize path is the sanitizer's designed recovery).
_STREAM_BARE_SECRET = re.compile(r"(?<![A-Za-z0-9/+=])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])")


class _StreamSanitizer:
    """Incrementally sanitize the live delta stream.

    Maintains the accumulated raw text; each push computes the sanitized view
    (streaming-safe CoT strip → redaction + eager
    stream-only masking), holds back a ~128-char tail PLUS any still-growing
    trailing secret-alphabet token (flushed at the end) so a secret completing
    across deltas can never leak an un-redacted prefix, and emits only the
    monotonic extension of what was already emitted. When the sanitized view
    diverges from the emitted prefix, nothing more is emitted — the persisted
    final answer corrects the client's view.
    """

    def __init__(self) -> None:
        self.emitted = ""

    @staticmethod
    def _visible(raw: str) -> str:
        text = redact_text(strip_chain_of_thought_stream(raw))
        return _STREAM_BARE_SECRET.sub(REDACTED, text)

    def push(self, raw_acc: str, final: bool = False) -> str:
        visible = self._visible(raw_acc)
        if not final:
            cut = len(visible) - _STREAM_TAIL_HOLDBACK
            if cut <= 0:
                return ""
            # Never split an in-progress long token: if the trailing token
            # started before the fixed-tail boundary, hold back from its start.
            m = _SECRET_TOKEN_TAIL.search(visible)
            if m is not None and m.start() < cut:
                cut = m.start()
            if cut <= 0:
                return ""
            visible = visible[:cut]
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


def _remember_rejection(attr: str, result: Any) -> None:
    """Record an endpoint capability refusal on the process-wide memory sets.

    The sets live on ``session_agent`` (the runtime entry) so tests and the
    agent builder share ONE binding; looked up lazily to avoid an import cycle."""
    key = getattr(result, "_sa_endpoint_key", None)
    if not key:
        return
    from . import session_agent as entry
    getattr(entry, attr).add(key)


class _Segments:
    """The turn's ordered transcript items, built live.

    A Codex-style turn is a sequence of MESSAGE segments (short commentary the
    model writes before it acts) interleaved with TOOL rows, and ends with the
    ANSWER. Each segment is sanitized on its own and closed at the model's
    message boundary; the last one becomes the Work Result."""

    def __init__(self) -> None:
        self.items: list[dict[str, Any]] = []
        self.raw = ""
        self.sanitizer = _StreamSanitizer()
        self.pending: str | None = None  # a closed segment not yet classified

    def delta(self, text: str) -> str:
        self.raw += text
        return self.sanitizer.push(self.raw)

    def close(self) -> list[tuple[str, Any]]:
        """Close the open segment at a message boundary. Returns the stream
        events to emit (the held-back tail, then the committed commentary)."""
        out: list[tuple[str, Any]] = []
        if self.pending is not None:
            # An earlier closed segment followed by MORE model text: it was
            # commentary, not the answer.
            out.append(("segment", {"text": self.pending, "final": False}))
            self.items.append({"kind": "message", "text": self.pending})
            self.pending = None
        if not self.raw:
            return out
        tail = self.sanitizer.push(self.raw, final=True)
        if tail:
            out.append(("delta", tail))
        text = sanitize_answer_text(self.raw)
        self.raw = ""
        self.sanitizer = _StreamSanitizer()
        if text:
            self.pending = text
        return out

    def commit_pending_before_tool(self) -> list[tuple[str, Any]]:
        """A tool call after a closed segment: that segment was commentary."""
        out: list[tuple[str, Any]] = []
        if self.pending is not None:
            out.append(("segment", {"text": self.pending, "final": False}))
            self.items.append({"kind": "message", "text": self.pending})
            self.pending = None
        return out

    def tool(self, record: dict[str, Any]) -> None:
        if record.get("status") == "started":
            return
        self.items.append({"kind": "tool", "id": record.get("id"),
                           "tool": record.get("tool")})

    def partial_text(self) -> str:
        """Everything the model has said in the OPEN/pending segment, sanitized
        (the cancel path persists this + a stopped marker)."""
        parts = [t for t in (self.pending, sanitize_answer_text(self.raw)) if t]
        return "\n\n".join(parts).strip()

    def finish(self, answer: str) -> list[tuple[str, Any]]:
        """Close everything at the end of the run. ``answer`` is the run's final
        output; a pending segment that equals it is the answer, not commentary."""
        out: list[tuple[str, Any]] = []
        if self.raw:
            out.extend(self.close())
        if self.pending is not None:
            if answer.strip() and self.pending.strip() != answer.strip() \
                    and not answer.strip().startswith(self.pending.strip()[:200]):
                out.append(("segment", {"text": self.pending, "final": False}))
                self.items.append({"kind": "message", "text": self.pending})
            self.pending = None
        return out


async def stream_events_for(result: Any, activity: list[dict[str, Any]], skill_names: list[str],
                            finalize=None, *, cancel_event: Any = None,
                            clients: list[Any] | None = None,
                            budget: dict[str, Any] | None = None,
                            answer_cap: int | None = None):
    """Yield the turn as it happens, then its final Work Result.

    Event kinds:
      ('delta', text)          sanitized live text of the OPEN segment
      ('segment', {text, final}) a closed message segment: commentary the model
                               wrote before acting (final=False) or the answer
                               (final=True) — the client replaces its live text
                               with the committed, fully sanitized version
      ('tool', record)         a tool row (started / completed)
      ('final', contract)      {answer, turn_items, tool_activity, grounding…}

    - Deltas are SANITIZED live (see _StreamSanitizer): CoT-stripped, redacted,
      tail held back until the segment closes.
    - If the run hits its step budget (max_turns) or the provider's context
      window and a ``finalize`` callable was provided, the failure is NOT
      surfaced as an error: a tool-less finalize synthesizes a grounded answer
      and the stream ends with a normal 'final' (marked as cut short).
    - If ``cancel_event`` is set mid-run, the SDK run is cancelled and the
      stream ends with a 'final' carrying the PARTIAL sanitized answer + a
      "stopped by user" marker and ``stopped: True``.
    - Every client in ``clients`` is closed when the turn ends, however it ends.
    """
    from openai.types.responses import ResponseTextDeltaEvent
    emitted_tools = 0
    seg = _Segments()

    def _stamped(contract: dict[str, Any]) -> dict[str, Any]:
        """Attach measured token usage to a final contract, if the provider
        reported any. Absent key == unavailable; never a fabricated zero."""
        usage = _usage_snapshot(result)
        if usage:
            contract["usage"] = usage
        # What the turn's own governor did: the ceiling this turn ran under and
        # the identical calls answered from the conversation instead of re-run.
        # Facts about THIS turn, reported beside usage, never inside it.
        if budget:
            if budget.get("token_limit"):
                contract["budget_tokens"] = int(budget["token_limit"])
            if budget.get("stopped_on"):
                contract["budget_stopped_on"] = str(budget["stopped_on"])
            if budget.get("deduped"):
                contract["repeat_calls_avoided"] = int(budget["deduped"])
        contract["turn_items"] = list(seg.items)
        return contract

    def _drain_tools():
        nonlocal emitted_tools
        out = []
        while len(activity) > emitted_tools:
            rec = activity[emitted_tools]
            seg.tool(rec)
            out.append(("tool", rec))
            emitted_tools += 1
        return out

    def _stopped_contract() -> dict[str, Any]:
        partial = seg.partial_text()
        answer_text = (partial + "\n\n" if partial else "") + _STOPPED_MARKER
        contract = _finalize_contract(answer_text, skill_names, activity, cap=answer_cap)
        contract["stopped"] = True
        return _stamped(contract)

    try:
        try:
            async for event in result.stream_events():
                if cancel_event is not None and cancel_event.is_set():
                    _cancel_streaming(result)
                    # The model call we just cut off produced tokens the endpoint
                    # will never report — record it so the footer shows a floor.
                    result._sa_unreported_requests = (
                        getattr(result, "_sa_unreported_requests", 0) + 1)
                    for ev in _drain_tools():
                        yield ev
                    yield ("final", _stopped_contract())
                    return
                etype = getattr(event, "type", "")
                if etype == "raw_response_event" and isinstance(event.data, ResponseTextDeltaEvent):
                    if event.data.delta:
                        if seg.pending is not None:
                            # More text after a closed message: the closed one
                            # was commentary.
                            for ev in seg.commit_pending_before_tool():
                                yield ev
                        out = seg.delta(event.data.delta)
                        if out:
                            yield ("delta", out)
                elif etype == "run_item_stream_event":
                    name = getattr(event, "name", "")
                    if name == "message_output_created":
                        for ev in seg.close():
                            yield ev
                    elif name == "tool_called":
                        # Text with no message item before a tool call (some
                        # Chat Completions servers): close it here.
                        for ev in seg.close():
                            yield ev
                        for ev in seg.commit_pending_before_tool():
                            yield ev
                for ev in _drain_tools():
                    yield ev
        except Exception as exc:  # noqa: BLE001
            if cancel_event is not None and cancel_event.is_set():
                # The user hit Stop while the failing call was in flight. Honor
                # the cancel: persist the PARTIAL answer with stopped=True — do
                # NOT launch a fresh finalize model call.
                for ev in _drain_tools():
                    yield ev
                yield ("final", _stopped_contract())
                return
            # Unless the SDK simply ran out of turns (which happens AFTER a
            # completed response), a model call died mid-flight and its usage
            # is unknown: record it so token counts read as a floor.
            if not _is_max_turns(exc):
                result._sa_unreported_requests = (
                    getattr(result, "_sa_unreported_requests", 0) + 1)
            cut_short = _is_context_overflow(exc) and not _is_max_turns(exc)
            transient = ((_is_transient_provider_error(exc) or _is_model_timeout(exc))
                         and not _is_max_turns(exc) and not cut_short)
            # Endpoint capability refusals (usage / parallel tools / cache hint)
            # are remembered for the process and the turn recovers through the
            # finalize pass, which rebuilds the agent without the parameter.
            usage_rejected = _is_stream_options_rejection(exc)
            if usage_rejected:
                _remember_rejection("_NO_USAGE_ENDPOINTS", result)
            sequence_broken = _is_tool_call_sequence_error(exc)
            if sequence_broken:
                _remember_rejection("_NO_PARALLEL_ENDPOINTS", result)
            cache_rejected = _is_cache_retention_rejection(exc)
            if cache_rejected:
                _remember_rejection("_NO_CACHE_RETENTION_ENDPOINTS", result)
            recoverable = (_is_max_turns(exc) or cut_short or transient
                           or usage_rejected or sequence_broken or cache_rejected)
            if finalize is None or not recoverable:
                raise
            for ev in _drain_tools():
                yield ev
            # Whatever the model said before the error is commentary; the
            # finalize pass writes the answer.
            for ev in seg.close():
                yield ev
            for ev in seg.commit_pending_before_tool():
                yield ev
            text = await finalize() or _FINALIZE_FALLBACK
            if cut_short:
                text = text + "\n\n" + _CONTEXT_CUT_MARKER
            elif transient:
                text = text + "\n\n" + _TRANSIENT_CUT_MARKER
            contract = _finalize_contract(text, skill_names, activity, cap=answer_cap)
            contract["cut_short"] = True
            yield ("segment", {"text": contract["answer"], "final": True})
            yield ("final", _stamped(contract))
            return
        for ev in _drain_tools():
            yield ev
        final_text = getattr(result, "final_output", "") or ""
        if not isinstance(final_text, str):
            final_text = str(final_text)
        for ev in seg.finish(final_text):
            yield ev
        # The per-turn tool-output budget was what forced the model to stop:
        # a best-effort answer, marked as cut short.
        if budget and budget.get("exhausted") and _BUDGET_CUT_MARKER not in final_text:
            final_text = (final_text + "\n\n" + _BUDGET_CUT_MARKER).strip()
        contract = _finalize_contract(final_text, skill_names, activity, cap=answer_cap,
                                      streamed=seg.partial_text())
        if budget and budget.get("exhausted"):
            contract["cut_short"] = True
        yield ("segment", {"text": contract["answer"], "final": True})
        yield ("final", _stamped(contract))
    finally:
        await _close_clients(clients)
