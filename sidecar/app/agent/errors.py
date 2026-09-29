"""Classifying a failed turn: what can still produce an answer, what the user must fix."""

from __future__ import annotations

from ..security.redaction import redact_text

_CONTEXT_NEEDLES = ("context length", "context_length_exceeded", "maximum context length")
_CONTEXT_WEAK = ("context window", "input is too long", "prompt is too long")
_TRANSIENT_STATUS = {429, 500, 502, 503, 504}


def is_max_turns(exc: BaseException) -> bool:
    try:
        from agents.exceptions import MaxTurnsExceeded
        if isinstance(exc, MaxTurnsExceeded):
            return True
    except Exception:  # noqa: BLE001
        pass
    return type(exc).__name__ == "MaxTurnsExceeded"


def is_context_overflow(exc: BaseException) -> bool:
    if str(getattr(exc, "code", "") or "").lower() == "context_length_exceeded":
        return True
    msg = str(exc).lower()
    if any(n in msg for n in _CONTEXT_NEEDLES):
        return True
    bad_request = getattr(exc, "status_code", None) == 400 or "badrequest" in type(exc).__name__.lower()
    return bad_request and any(n in msg for n in _CONTEXT_WEAK)


def is_transient(exc: BaseException) -> bool:
    if getattr(exc, "status_code", None) in _TRANSIENT_STATUS:
        return True
    name = type(exc).__name__.lower()
    if any(t in name for t in ("ratelimit", "internalserver", "serviceunavailable", "timeout")):
        return True
    return type(exc).__name__ == "ModelTimeoutError"


def is_tool_sequence(exc: BaseException) -> bool:
    msg = str(exc).lower()
    if not (getattr(exc, "status_code", None) == 400 or "code: 400" in msg):
        return False
    return "insufficient tool messages" in msg or "tool_call_id" in msg or (
        "tool_calls" in msg and "must be followed" in msg)


def is_parallel_refusal(exc: BaseException) -> bool:
    msg = str(exc).lower()
    return "parallel_tool_calls" in msg and ("unsupported" in msg or "not support" in msg or "unknown" in msg)


def is_usage_refusal(exc: BaseException) -> bool:
    msg = str(exc).lower()
    return "stream_options" in msg or "include_usage" in msg


def recoverable(exc: BaseException) -> bool:
    """The work so far is still good: write an answer from it without tools."""
    return is_max_turns(exc) or is_context_overflow(exc) or is_transient(exc) or is_tool_sequence(exc)


def user_message(exc: BaseException) -> str:
    """A failure the user can act on — never a raw stack or a secret."""
    status = getattr(exc, "status_code", None)
    name = type(exc).__name__
    if status in (401, 403) or "authentication" in name.lower() or "permission" in name.lower():
        return "The model endpoint refused the API key. Check it in Settings › Models."
    if status == 404 or "notfound" in name.lower():
        return "The model endpoint does not know this model. Check the model name in Settings › Models."
    if "connection" in name.lower() or "connect" in str(exc).lower()[:200]:
        return "The model endpoint could not be reached. Check the base URL and your network."
    return "The Agent stopped with an error: " + redact_text(str(exc))[:300]


def is_websocket_failure(exc: BaseException) -> bool:
    """The Responses websocket transport could not be used (a proxy, a firewall)."""
    text = f"{type(exc).__name__} {exc}".lower()
    return "websocket" in text or "wss://" in text
