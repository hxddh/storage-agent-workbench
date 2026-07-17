"""Regression: the blocking-fallback turn loop must start the SDK stream from
INSIDE its event loop.

`Runner.run_streamed` schedules the agent loop via `asyncio.create_task`, which
raises ``RuntimeError: no running event loop`` when called outside a running
loop. The blocking `_streamed_session_loop` used to call `_start_streamed_run`
before `run_until_complete`, so any turn that fell back to POST /messages (e.g.
after the user switched sessions and the SSE stream dropped) crashed with
"no running event loop". The whole SESSION_LOOP path is normally monkeypatched
away in tests, which is exactly why the regression shipped — this test drives the
real `_streamed_session_loop` and only stubs the SDK boundary.
"""
import asyncio

import pytest

from app.agent_runtime import session_agent


def test_streamed_loop_starts_run_inside_running_loop(monkeypatch):
    started_with_running_loop = {}

    def fake_start(spec, clients=None):
        # This is where Runner.run_streamed() lives. It MUST see a running loop.
        try:
            asyncio.get_running_loop()
            started_with_running_loop["ok"] = True
        except RuntimeError as exc:  # "no running event loop" — the bug
            started_with_running_loop["ok"] = False
            raise
        return ("fake-result", lambda: None, [])

    async def fake_stream(result, activity, skill_names, finalize, *, cancel_event=None,
                          clients=None, budget=None, answer_cap=None):
        yield "final", {"answer": "hi", "skills_used": [], "evidence_used": [],
                        "evidence_gaps": [], "next_action_proposals": []}

    monkeypatch.setattr(session_agent, "_start_streamed_run", fake_start)
    monkeypatch.setattr(session_agent, "stream_events_for", fake_stream)

    spec = {"activity": [], "skill_names": [], "cancel_event": None}
    out = session_agent._streamed_session_loop(spec)

    assert started_with_running_loop.get("ok") is True
    assert out["answer"] == "hi"
