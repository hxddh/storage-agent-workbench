"""v10 — replayed small-model failure shapes (default CI).

Each test scripts what small local models were seen to do — a tool call
written as text, arguments that are not JSON, the same call again and again, a
string where a list belongs — and pins that the runtime handles it: the Turn
completes, the stream stays well-formed, and nothing runs that should not.
"""

from __future__ import annotations

import time

from app.agent import runtime
from app.agent import tools as _tools  # noqa: F401
from app.agent.tools import registry
from tests.fake_model import FakeModel, chat_violations, raw_tool_turn, text_turn, tool_turn


def _use(client, fake: FakeModel) -> str:
    return client.post("/providers/models", json={"name": "fake", "kind": "openai-compatible",
                                                   "base_url": fake.base_url, "model": "fake-model"}).json()["id"]


def _settle(client, task_id: str, timeout: float = 30.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        snap = client.get(f"/tasks/{task_id}").json()
        if snap["state"] not in ("working", "queued"):
            return snap
        time.sleep(0.05)
    raise AssertionError(f"task still {snap['state']}")


def _run(client, turns, direction: str = "Check my storage", **kw) -> tuple[dict, FakeModel]:
    with FakeModel(turns, **kw) as fake:
        _use(client, fake)
        tid = client.post("/tasks", json={"direction": direction}).json()["task"]["id"]
        snap = _settle(client, tid)
    return snap, fake


def _counting_tool(monkeypatch, seen: list):
    td = registry.REGISTRY["list_uploaded_files"]

    def list_uploaded_files(aspects: list[str] | None = None, limit: int = 5, deep: bool = False) -> dict:
        """List files."""
        seen.append({"aspects": aspects, "limit": limit, "deep": deep})
        return {"success": True, "datasets": []}

    monkeypatch.setattr(td, "fn", list_uploaded_files)


def _well_formed(fake: FakeModel) -> None:
    for req in fake.requests:
        assert chat_violations(req["messages"]) == [], req["messages"]


# --- a tool call written as text ---------------------------------------------------------


def test_a_json_tool_call_written_as_text_is_reprompted_once(client):
    snap, fake = _run(client, [text_turn('{"name": "survey_account", "arguments": {}}'),
                               text_turn("I have not surveyed yet; here is what I know.")])
    assert snap["turns"][0]["status"] == "completed"
    assert [i["payload"]["event"] for i in snap["items"] if i["type"] == "notice"].count("reprompted") == 1
    assert len(fake.requests) == 2
    last = fake.requests[1]["messages"]
    assert last[-1]["role"] == "user" and "tool call written as text" in last[-1]["content"]
    answers = [i["payload"]["text"] for i in snap["items"] if i["type"] == "agent_message"]
    assert answers[-1].startswith("I have not surveyed yet")
    _well_formed(fake)


def test_tagged_tool_calls_are_reprompted_but_never_in_a_loop(client):
    tagged = '<tool_call>\n{"name": "list_buckets", "arguments": {}}\n</tool_call>'
    snap, fake = _run(client, [text_turn(tagged)])  # the model keeps doing it
    assert snap["turns"][0]["status"] == "completed"
    assert len(fake.requests) == 2  # one correction, then the answer is accepted as it is


def test_prose_that_mentions_json_is_not_a_tool_call():
    assert not runtime.looks_like_text_tool_call("The bucket policy is {\"Version\": \"2012-10-17\"}.")
    assert not runtime.looks_like_text_tool_call('{"name": "prod", "arguments": 3}')  # not a tool
    assert runtime.looks_like_text_tool_call('```json\n{"name": "list_buckets", "parameters": {}}\n```')
    assert runtime.looks_like_text_tool_call('[{"function": {"name": "survey_account", "arguments": "{}"}}]')
    assert runtime.looks_like_text_tool_call("[TOOL_CALLS] survey_account")


# --- arguments ---------------------------------------------------------------------------


def test_arguments_that_are_not_json_are_answered_not_run(client, monkeypatch):
    seen: list = []
    _counting_tool(monkeypatch, seen)
    snap, fake = _run(client, [raw_tool_turn("list_uploaded_files", "{aspects: [security], limit: 3"),
                               text_turn("Could not list.")])
    assert snap["turns"][0]["status"] == "completed" and seen == []
    out = next(i["payload"] for i in snap["items"] if i["type"] == "tool_output")
    assert out["ok"] is False and out["summary"] == "arguments were not valid JSON"
    tool_msg = next(m for m in fake.requests[1]["messages"] if m.get("role") == "tool")
    assert "not a valid JSON object" in tool_msg["content"]
    _well_formed(fake)


def test_a_string_where_a_list_belongs_is_coerced(client, monkeypatch):
    seen: list = []
    _counting_tool(monkeypatch, seen)
    snap, _ = _run(client, [
        tool_turn("list_uploaded_files", {"aspects": "security", "limit": "3", "deep": "true"}),
        tool_turn("list_uploaded_files", {"aspects": "security, lifecycle"}),
        tool_turn("list_uploaded_files", {"aspects": '["cost"]'}),
        text_turn("Done.")])
    assert snap["turns"][0]["status"] == "completed"
    assert seen == [{"aspects": ["security"], "limit": 3, "deep": True},
                    {"aspects": ["security", "lifecycle"], "limit": 5, "deep": False},
                    {"aspects": ["cost"], "limit": 5, "deep": False}]


def test_coercion_leaves_what_it_does_not_know_alone():
    schema = {"properties": {"a": {"type": "array"}, "n": {"type": "integer"}}}
    assert runtime.coerce_args({"a": ["x"], "n": "many", "z": "q"}, schema) == {"a": ["x"], "n": "many", "z": "q"}
    assert runtime.parse_tool_args("") == {} and runtime.parse_tool_args("[1]") is None
    assert runtime.parse_tool_args('```json\n{"a": 1}\n```') == {"a": 1}


# --- repeated identical calls ------------------------------------------------------------


def test_a_repeated_identical_call_is_not_run_again(client, monkeypatch):
    seen: list = []
    _counting_tool(monkeypatch, seen)
    snap, fake = _run(client, [tool_turn("list_uploaded_files", {"limit": 2}),
                               tool_turn("list_uploaded_files", {"limit": 2}),
                               tool_turn("list_uploaded_files", {"limit": 3}),
                               text_turn("Done.")])
    assert snap["turns"][0]["status"] == "completed"
    assert [s["limit"] for s in seen] == [2, 3]  # the repeat never ran; different arguments did
    outs = [i["payload"] for i in snap["items"] if i["type"] == "tool_output"]
    assert [o["summary"] for o in outs][1] == "repeated call, not run" and outs[1]["ok"] is True
    tool_msgs = [m["content"] for m in fake.requests[2]["messages"] if m.get("role") == "tool"]
    assert tool_msgs[1] == runtime.REPEATED_CALL
    # Recorded and audited like any call: the stream and the audit stay complete.
    assert [i["type"] for i in snap["items"]].count("tool_call") == 3
    _well_formed(fake)


def test_a_repeat_in_a_later_turn_runs_again(client, monkeypatch):
    seen: list = []
    _counting_tool(monkeypatch, seen)
    with FakeModel([tool_turn("list_uploaded_files", {}), text_turn("One."),
                    tool_turn("list_uploaded_files", {}), text_turn("Two.")]) as fake:
        _use(client, fake)
        tid = client.post("/tasks", json={"direction": "First"}).json()["task"]["id"]
        _settle(client, tid)
        client.post(f"/tasks/{tid}/turns", json={"direction": "Again"})
        _settle(client, tid)
    assert len(seen) == 2


def test_a_model_that_loops_on_one_call_still_ends(client, monkeypatch):
    """The same call forever: every repeat is answered without running, and the
    step budget ends the loop with a finalized answer."""
    seen: list = []
    _counting_tool(monkeypatch, seen)
    monkeypatch.setattr(runtime, "MAX_TURN_STEPS", 6)
    snap, fake = _run(client, [tool_turn("list_uploaded_files", {}) for _ in range(10)], finalize="What I have so far.")
    assert len(seen) == 1
    assert snap["turns"][0]["status"] == "completed"
    assert "finalized" in [i["payload"]["event"] for i in snap["items"] if i["type"] == "notice"]
    notes = [i["payload"]["summary"] for i in snap["items"] if i["type"] == "tool_output"]
    assert len(notes) >= 3 and set(notes[1:]) == {"repeated call, not run"}
    assert fake.finalize_requests
