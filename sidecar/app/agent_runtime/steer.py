"""Mid-execution steer queue and its injection into the running model loop."""

from __future__ import annotations

from typing import Any

from ..security.redaction import redact_text


class SteerQueue:
    """Thread-safe carrier for mid-execution Direction (steer) text.

    The runtime pushes; the running execution drains at the next tool boundary
    and the text is injected as a runtime note the model must follow. This is
    what makes Steer act ON the current execution instead of cancelling the
    turn and re-running: the investigation, its tool trace, and its budget all
    continue. ``undelivered()`` lets the driver detect a steer that arrived too
    late to be injected (the model was already writing its final answer) so it
    can be carried into a follow-up execution rather than dropped."""

    def __init__(self) -> None:
        import threading
        self._lock = threading.Lock()
        self._pending: list[str] = []
        self.delivered: list[str] = []

    def push(self, text: str) -> None:
        clean = redact_text(str(text or "")).strip()
        if not clean:
            return
        with self._lock:
            self._pending.append(clean[:4000])

    def drain(self) -> list[str]:
        with self._lock:
            out = self._pending
            self._pending = []
            self.delivered.extend(out)
            return out

    def undelivered(self) -> list[str]:
        with self._lock:
            out = self._pending
            self._pending = []
            return out


_STEER_NOTE = (
    "\n\n[USER STEER — runtime notice, not tool data] The user just steered this "
    "execution: {steers}\nAdjust the investigation NOW to follow this direction; "
    "where it conflicts with the original question, the steer wins. Do not "
    "restart from scratch — keep everything you have already established."
)


def _install_steer_injection(tools: list[Any], steer_queue: Any,
                             activity: list[dict[str, Any]] | None) -> None:
    """Deliver pending steer text at the next tool boundary (OUTERMOST wrapper).

    Installed after the budget wrapper so the steer note rides on whatever the
    tool returns — real payloads and runtime statuses alike — and sits OUTSIDE
    the untrusted-data envelope: a steer is the user's own direction, exactly as
    trusted as the original question. The activity trace records the delivery so
    the Execution review shows when the course changed."""
    if steer_queue is None:
        return
    for t in tools:
        orig = getattr(t, "on_invoke_tool", None)
        if orig is None:
            continue

        def _make(_orig):
            async def wrapped(ctx: Any, args: Any) -> Any:
                out = await _orig(ctx, args)
                steers = steer_queue.drain()
                if not steers:
                    return out
                if activity is not None:
                    for s in steers:
                        activity.append({"tool": "user_steer", "target": "",
                                         "result": s[:120], "ok": True,
                                         "status": "completed"})
                quoted = " | ".join(f'"{s}"' for s in steers)
                return f"{out}{_STEER_NOTE.format(steers=quoted)}"
            return wrapped

        try:
            t.on_invoke_tool = _make(orig)
        except Exception:  # noqa: BLE001 — frozen/foreign tool object: skip
            pass


