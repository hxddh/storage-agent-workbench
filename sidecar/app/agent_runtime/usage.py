"""Token-usage accounting and provider capability-rejection detectors."""

from __future__ import annotations

from typing import Any



_PROMPT_CACHE_RETENTION = "24h"


def _endpoint_key(creds: dict[str, Any]) -> str:
    return f"{creds.get('base_url') or 'openai'}|{creds.get('model') or ''}"


# --- token usage (measured, never estimated) ---------------------------------
# The SDK accumulates usage on the run's context wrapper. A turn can involve TWO
# model runs (the tool loop, plus the tool-less finalize pass), so the finalize
# run's usage is stashed on the streaming result and summed in — a turn's cost is
# what the turn actually spent, not just its first run.

def _stash_extra_usage(result: Any, other: Any) -> None:
    """Record a secondary run's usage against the turn's primary result."""
    try:
        usage = other.context_wrapper.usage
    except Exception:  # noqa: BLE001
        return
    if usage is None:
        return
    try:
        result._sa_extra_usage = [*getattr(result, "_sa_extra_usage", []), usage]
    except Exception:  # noqa: BLE001 - never let bookkeeping break a turn
        pass


def _usage_snapshot(result: Any) -> dict[str, Any] | None:
    """Measured token usage for the turn, or None if the provider didn't report it.

    None is a first-class answer: many OpenAI-compatible endpoints simply omit
    usage on streamed responses. The UI must then say "unavailable" — an
    estimate, or a confident zero, would be a lie about real spend.
    """
    parts = []
    try:
        primary = result.context_wrapper.usage
    except Exception:  # noqa: BLE001
        primary = None
    if primary is not None:
        parts.append(primary)
    parts.extend(getattr(result, "_sa_extra_usage", []) or [])
    if not parts:
        return None
    out = {"requests": 0, "input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
    for u in parts:
        for key in out:
            try:
                out[key] += int(getattr(u, key, 0) or 0)
            except (TypeError, ValueError):
                pass
    # An endpoint that answered without usage yields a zeroed Usage object. That
    # is "not reported", not "free" — the TOKEN counts must read as unavailable.
    if out["total_tokens"] <= 0 and out["input_tokens"] <= 0 and out["output_tokens"] <= 0:
        # …but the REQUEST count is ours, not the provider's: the SDK counts the
        # model calls it made, so it is a real measurement even when the endpoint
        # reports nothing. Measured against `FakeModel` (which omits `usage`, as
        # many OpenAI-compatible endpoints do on streamed responses) for a turn
        # of one tool step plus one answer step: openai-agents 0.19.4 reported
        # `requests=0`, 0.20.0 reports `requests=2`. This used to return None and
        # throw that away, so those users saw nothing at all about their turn.
        #
        # The token fields go back to None rather than staying 0 — deliberately.
        # The renderer decides "were tokens reported?" by formatting them, and
        # `0` formats as "0", which would put a confident "↑0 ↓0" on screen. An
        # unreported count is not a zero.
        aborted = max(0, int(getattr(result, "_sa_unreported_requests", 0) or 0))
        if out["requests"] + aborted > 0:
            return {"requests": out["requests"] + aborted, "input_tokens": None,
                    "output_tokens": None, "total_tokens": None}
        return None
    out.update(_usage_details(parts))
    # PARTIAL reporting is its own state, and it used to render as a confident
    # total. A turn makes several model calls; an OpenAI-compatible endpoint may
    # report usage on some and omit it on others (it is omitted per RESPONSE, not
    # per endpoint — a streamed answer often carries usage while a tool-call step
    # does not). Summing what came back then produced a precise-looking "↑12.4k"
    # that was really "↑12.4k out of an unknown larger number" — the product
    # stating a figure it had not established.
    #
    # The SDK gives the denominator for free: `Usage.add()` appends a
    # `request_usage_entries` row only for a response that carried non-zero
    # usage, while `requests` counts every model call it made. So
    # `entries < requests` is exactly "some calls reported nothing", and the
    # totals below are a FLOOR. Pinned against the SDK in
    # test_v086_model_bounds_and_usage_honesty.py, since it rests on that
    # behaviour rather than on documented API.
    reported = 0
    for u in parts:
        try:
            reported += len(getattr(u, "request_usage_entries", None) or [])
        except TypeError:
            pass
    # A model call that FAILED is invisible to both counters: usage is added
    # only when a response completes, so an attempt aborted mid-stream — by the
    # `_MODEL_TIMEOUT_S` deadline, by a cancel, by a provider error — increments
    # neither `requests` nor `request_usage_entries` (verified against the SDK,
    # and pinned in test_v086). Left alone, the two counters agree and a turn
    # that lost a whole billable call would render as an exact total.
    #
    # We know that call happened, because we caught its error. Counting it here
    # makes `requests` true AND makes the ratio unequal, so the floor marker
    # follows from the same rule rather than needing a second flag.
    out["requests"] += max(0, int(getattr(result, "_sa_unreported_requests", 0) or 0))
    if 0 < reported < out["requests"]:
        out["reported_requests"] = reported
    return out


# The fixed prefix of a turn — instructions + tool schemas + the context JSON —
# is ~5.6k tokens and is re-sent on EVERY step of a multi-step turn. Whether the
# endpoint caches it is therefore the single biggest factor in what a turn
# costs, and reasoning tokens are output the user pays for and never sees. The
# SDK has reported both since usage capture landed; nothing read them.
def _usage_details(parts: list[Any]) -> dict[str, Any]:
    """Cached-input and reasoning token totals, or absent when unreported.

    A key is OMITTED rather than zeroed when no part of the turn reported it:
    "this endpoint does not tell us" and "nothing was cached" are different
    facts, and a confident 0 would answer the first with the second."""
    cached = reasoning = None
    for u in parts:
        c = _detail_int(getattr(u, "input_tokens_details", None), "cached_tokens")
        r = _detail_int(getattr(u, "output_tokens_details", None), "reasoning_tokens")
        if c is not None:
            cached = (cached or 0) + c
        if r is not None:
            reasoning = (reasoning or 0) + r
    out: dict[str, Any] = {}
    if cached is not None:
        out["cached_input_tokens"] = cached
    if reasoning is not None:
        out["reasoning_tokens"] = reasoning
    return out


def _detail_int(details: Any, field: str) -> int | None:
    """One token-detail field, or None when the endpoint omitted the block.

    Endpoints vary: some send no details object, some send it with the field
    absent, some send null. All three mean "not reported"."""
    if details is None:
        return None
    value = getattr(details, field, None)
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _is_stream_options_rejection(exc: BaseException) -> bool:
    """Did the endpoint refuse the usage request specifically?

    Narrow on purpose: only a parameter-shaped complaint naming stream_options /
    include_usage disables usage. A generic 400 must NOT be silently attributed
    to this, or a real bug becomes an invisible "usage unavailable"."""
    text = str(exc).lower()
    return ("stream_options" in text or "include_usage" in text) and (
        "unsupport" in text or "unknown" in text or "invalid" in text
        or "not allowed" in text or "unrecognized" in text or "extra" in text
    )


def _is_cache_retention_rejection(exc: BaseException) -> bool:
    """Did the endpoint refuse `prompt_cache_retention` specifically?

    Same narrowness as the usage detector, for the same reason: a cost
    optimization must never be able to swallow the blame for a real error. Only
    a parameter-shaped complaint that NAMES the parameter counts."""
    text = str(exc).lower()
    return "prompt_cache_retention" in text and (
        "unsupport" in text or "unknown" in text or "invalid" in text
        or "not allowed" in text or "unrecognized" in text or "extra" in text
    )


