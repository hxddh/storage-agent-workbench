"""v0.53.0 — what a turn costs, and what it says while it runs.

Two of the three tracks land in the sidecar.

**Serialization.** The context block was pretty-printed with ``indent=2``.
Measured on a 40-turn session that is 43,547 chars against 37,520 compact — 14%
of the context is indentation — and the context is re-sent on every step of a
multi-step turn, so a nine-request turn paid roughly 13k tokens for whitespace.
Tool results had the same issue at smaller scale.

**Cost visibility.** The SDK reports ``input_tokens_details.cached_tokens`` and
``output_tokens_details.reasoning_tokens``; nothing read either. The fixed
prefix (instructions + tool schemas + context) is ~5k tokens re-sent on every
step, so whether the endpoint caches it is the single biggest factor in a turn's
price — and reasoning tokens are output the user pays for and never sees.

Plus the live trace's arguments (the frontend half is in
``src/components/trace.test.tsx``), which were recorded to ``tool_calls`` all
along and never sent to the client.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from app import db
from app.agent_runtime import session_agent as sa
from app.agent_runtime import session_tools


# --- serialization -----------------------------------------------------------


def _big_context() -> dict:
    msgs = []
    for i in range(40):
        msgs.append({"role": "user", "content": f"question {i} about acme-logs " * 6})
        msgs.append({"role": "assistant", "content": f"answer {i}. " + "detail. " * 40,
                     "tool_activity": [{"tool": "head_bucket", "target": "acme-logs",
                                        "result": "ok", "status": "completed"}]})
    summary = {"summary_md": "s" * 400,
               "known_facts": [{"text": f"fact {i} " * 20, "confidence": "high"} for i in range(20)],
               "findings": [{"severity": "high", "title": f"f{i}", "interpretation": "y" * 250}
                            for i in range(20)],
               "open_questions": [f"q{i}" for i in range(10)], "limitations": []}
    memory = [{"id": f"m{i}", "kind": "fact", "text": f"memory {i} " * 12} for i in range(50)]
    return sa.build_session_context({"title": "acme", "goal": "diagnose", "status": "active"},
                                    summary, msgs, memory, model="gpt-4o",
                                    explicit_window=128_000)


def test_the_context_carries_no_indentation_whitespace():
    ctx = _big_context()
    text = sa.render_context_text(ctx)
    pretty = json.dumps(ctx, indent=2, default=str)
    # The saving is real and large, not a rounding difference.
    assert len(text) < len(pretty) * 0.90, f"{len(text)} vs {len(pretty)}"
    assert "\n  " not in text


def test_the_context_still_round_trips_to_the_same_data():
    ctx = _big_context()
    # Compactness must not cost fidelity: the model receives the same object.
    assert json.loads(sa.render_context_text(ctx)) == json.loads(
        json.dumps(ctx, default=str))


def test_non_ascii_survives_unescaped():
    ctx = sa.build_session_context({"title": "存储桶诊断", "goal": "", "status": "active"},
                                   {"known_facts": [], "findings": []}, [], [])
    text = sa.render_context_text(ctx)
    # ensure_ascii=False keeps CJK as characters instead of six-byte \\uXXXX
    # escapes — smaller AND what the model reads natively.
    assert "存储桶诊断" in text


def test_tool_results_are_compact_too():
    res = {"success": True, "keys": [f"logs/{i}" for i in range(200)], "key_count": 200}
    out = session_tools._out(res)
    assert ", " not in out and '": ' not in out
    assert json.loads(out) == res


# --- cached / reasoning tokens ----------------------------------------------


def _usage(**kw):
    base = {"requests": 1, "input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
    base.update(kw)
    return SimpleNamespace(**base)


def _result(*usages):
    r = SimpleNamespace(context_wrapper=SimpleNamespace(usage=usages[0]))
    r._sa_extra_usage = list(usages[1:])
    return r


def test_cached_and_reasoning_tokens_are_captured():
    u = _usage(input_tokens=12_000, output_tokens=800, total_tokens=12_800,
               input_tokens_details=SimpleNamespace(cached_tokens=9_600),
               output_tokens_details=SimpleNamespace(reasoning_tokens=320))
    snap = sa._usage_snapshot(_result(u))
    assert snap["cached_input_tokens"] == 9_600
    assert snap["reasoning_tokens"] == 320


def test_details_sum_across_a_turns_two_runs():
    # A turn can involve a second run (the tool-less finalize pass); its usage is
    # already summed, and the details must follow the same rule.
    a = _usage(input_tokens=10_000, total_tokens=10_000,
               input_tokens_details=SimpleNamespace(cached_tokens=8_000))
    b = _usage(input_tokens=2_000, total_tokens=2_000,
               input_tokens_details=SimpleNamespace(cached_tokens=1_500))
    snap = sa._usage_snapshot(_result(a, b))
    assert snap["cached_input_tokens"] == 9_500


@pytest.mark.parametrize("details", [None, SimpleNamespace(cached_tokens=None), SimpleNamespace()])
def test_an_endpoint_that_omits_the_detail_reports_absence_not_zero(details):
    u = _usage(input_tokens=5_000, total_tokens=5_000, input_tokens_details=details)
    snap = sa._usage_snapshot(_result(u))
    # "This endpoint does not tell us" and "nothing was cached" are different
    # facts. A confident 0 would answer the first with the second.
    assert "cached_input_tokens" not in snap
    assert snap["input_tokens"] == 5_000


def test_a_genuine_zero_is_still_reported():
    u = _usage(input_tokens=5_000, total_tokens=5_000,
               input_tokens_details=SimpleNamespace(cached_tokens=0))
    snap = sa._usage_snapshot(_result(u))
    # A cold cache IS a measurement, and the one worth acting on.
    assert snap["cached_input_tokens"] == 0


def test_tokens_stay_unavailable_when_nothing_was_reported():
    """The TOKEN counts must read as unreported — never as a confident zero.

    Sharpened in v0.77.0. This used to assert the whole snapshot was None, which
    also threw away the request count. `requests` is not a provider figure: the
    SDK counts the model calls it makes, so it is a real measurement even when
    the endpoint reports no usage at all.
    """
    u = _usage(input_tokens_details=SimpleNamespace(cached_tokens=0))
    snap = sa._usage_snapshot(_result(u))
    assert snap is not None
    assert snap["requests"] == 1
    # None, not 0: the renderer decides "were tokens reported?" by formatting
    # them, and 0 formats as "0" — which would put "↑0 ↓0" on screen.
    assert snap["input_tokens"] is None
    assert snap["output_tokens"] is None
    assert snap["total_tokens"] is None


def test_nothing_at_all_is_still_nothing():
    """No tokens AND no requests — an SDK too old to count them, or a turn that
    never reached the model. There is no measurement to report."""
    u = _usage(requests=0, input_tokens_details=SimpleNamespace(cached_tokens=0))
    assert sa._usage_snapshot(_result(u)) is None


def test_the_details_are_persisted_and_rolled_up(client):
    from app.repositories import session_activity

    sid = client.post("/sessions", json={"title": "cost"}).json()["id"]
    conn = db.connect()
    try:
        session_activity.record_turn(
            conn, sid, turn_id="t1", message_id="m1", model="gpt-4o",
            usage={"requests": 4, "input_tokens": 12_000, "output_tokens": 800,
                   "total_tokens": 12_800, "cached_input_tokens": 9_600,
                   "reasoning_tokens": 320},
            duration_ms=4200, tool_calls=3)
        conn.commit()
        roll = session_activity.usage_rollup(conn, sid)
        assert roll["cached_input_tokens"] == 9_600
        assert roll["reasoning_tokens"] == 320
        turns = session_activity.list_turns(conn, sid)
        assert turns[0]["cached_input_tokens"] == 9_600
    finally:
        conn.close()


def test_a_session_whose_endpoint_never_reported_details_says_so(client):
    from app.repositories import session_activity

    sid = client.post("/sessions", json={"title": "cost2"}).json()["id"]
    conn = db.connect()
    try:
        session_activity.record_turn(
            conn, sid, turn_id="t1", message_id="m1", model="local",
            usage={"requests": 1, "input_tokens": 900, "output_tokens": 100,
                   "total_tokens": 1000},
            duration_ms=900, tool_calls=0)
        conn.commit()
        roll = session_activity.usage_rollup(conn, sid)
        assert roll["available"] is True          # tokens WERE reported
        assert roll["cached_input_tokens"] is None  # …but not the cache detail
        assert roll["reasoning_tokens"] is None
    finally:
        conn.close()


# --- live trace arguments ----------------------------------------------------


def _provider(client) -> str:
    return client.post("/cloud-providers", json={
        "name": "probe", "provider_type": "s3-compatible",
        "endpoint_url": "https://minio.example.com", "region": "us-east-1",
        "access_key": "AKIAIOSFODNN7EXAMPLE",
        "secret_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    }).json()["id"]


def _run_tool(conn, name: str, **kwargs):
    """Invoke one registered agent tool and return the activity it emitted."""
    activity: list[dict] = []
    found: dict = {}

    def ft(fn=None, **_kw):
        def wrap(f):
            found.setdefault(f.__name__, f)
            return f
        return wrap(fn) if fn else wrap

    session_tools.build(conn, ft, activity, None)
    assert name in found, f"{name} is not registered"
    found[name](**kwargs)
    return activity


def test_the_live_trace_carries_the_arguments_that_define_the_call(client):
    """`list_objects · acme-logs` described a one-prefix scan and a full listing
    identically. The args were written to `tool_calls` all along — they just
    never reached the client."""
    pid = _provider(client)
    conn = db.connect()
    try:
        activity = _run_tool(conn, "list_objects", provider_id=pid, bucket="acme-logs",
                             prefix="logs/2026/08/", max_keys=1000, recursive=True)
    finally:
        conn.close()
    started = [a for a in activity if a.get("status") == "started"]
    assert started, "no started record was emitted"
    args = started[0]["args"]
    assert args["prefix"] == "logs/2026/08/"
    assert args["max_keys"] == 1000
    assert args["recursive"] is True
    # The finished record repeats them, so the row does not change meaning when
    # the call resolves.
    done = [a for a in activity if a.get("status") == "completed"]
    assert done and done[0]["args"]["prefix"] == "logs/2026/08/"


def test_arg_selection_drops_what_a_reader_cannot_use(client):
    pid = _provider(client)
    conn = db.connect()
    try:
        activity = _run_tool(conn, "head_object", provider_id=pid, bucket="acme-logs",
                             key="logs/app.log")
    finally:
        conn.close()
    args = [a for a in activity if a.get("status") == "started"][0]["args"]
    # bucket/key are already the `target`; provider_id is an opaque id. Repeating
    # them would spend the row's width on nothing.
    assert "provider_id" not in args and "bucket" not in args and "key" not in args


def test_trace_arguments_are_redacted_like_everything_else(client):
    pid = _provider(client)
    conn = db.connect()
    try:
        activity = _run_tool(conn, "list_objects", provider_id=pid, bucket="acme-logs",
                             prefix="AKIAIOSFODNN7EXAMPLE/")
    finally:
        conn.close()
    args = [a for a in activity if a.get("status") == "started"][0]["args"]
    # A prefix is user-supplied text that lands in the UI and the exported
    # record (rule 15).
    assert "AKIAIOSFODNN7EXAMPLE" not in str(args)
