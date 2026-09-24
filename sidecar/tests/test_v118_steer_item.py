"""v1.18 — a Steer is a Direction, never a tool row.

The steer wrapper records a delivery notice in the turn's activity; the live
stream persists it as ``steer.applied``. The durable transcript must carry the
same fact as a ``steer`` turn item (it used to become an unresolvable tool
reference, so the saved transcript silently lost it)."""
from app.agent_runtime.stream import _Segments


def test_a_user_steer_notice_becomes_a_steer_item_between_tool_rows():
    seg = _Segments()
    seg.tool({"id": "a", "tool": "head_bucket", "status": "completed"})
    seg.tool({"tool": "user_steer", "target": "", "result": "  only the logs bucket ",
              "ok": True, "status": "completed"})
    seg.tool({"id": "b", "tool": "list_objects", "status": "completed"})
    assert [i["kind"] for i in seg.items] == ["tool", "steer", "tool"]
    assert seg.items[1] == {"kind": "steer", "text": "only the logs bucket"}
    assert not any(i.get("tool") == "user_steer" for i in seg.items)


def test_an_empty_steer_notice_adds_nothing():
    seg = _Segments()
    seg.tool({"tool": "user_steer", "result": "   ", "status": "completed"})
    assert seg.items == []


def test_a_steer_item_survives_persistence_and_reload(client, monkeypatch):
    """The saved transcript keeps the steer at its in-turn position: the
    repository's turn-item allowlist must carry the kind the segmenter emits
    (it used to drop it, so the Steered line vanished on reload)."""
    from app.agent_runtime import session_agent
    from tests.test_v111_native_turns import _add_model_provider, _task, _wait_settled

    task = _task(client)
    _add_model_provider(client)

    def fake_loop(spec):
        spec["activity"].append({"id": "c1", "tool": "list_buckets", "target": "p1",
                                 "result": "2 buckets", "ok": True, "status": "completed"})
        return {"answer": "Only the logs bucket.", "skills_used": [], "skills_offered": [],
                "evidence_used": [], "evidence_gaps": [],
                "tool_activity": list(spec["activity"]),
                "turn_items": [{"kind": "tool", "id": "c1", "tool": "list_buckets"},
                               {"kind": "steer", "text": "  only the logs bucket  "},
                               {"kind": "steer", "text": "   "}]}

    monkeypatch.setattr(session_agent, "SESSION_LOOP", fake_loop)
    r = client.post(f"/agent-tasks/{task['id']}/executions", json={"direction": "what buckets?"})
    exec_id = r.json()["execution"]["id"]
    assert _wait_settled(client, task["id"], exec_id)["status"] == "completed"
    msgs = client.get(f"/sessions/{task['id']}").json()["messages"]
    assistant = [m for m in msgs if m["role"] == "assistant"][-1]
    assert assistant["turn_items"] == [{"kind": "tool", "id": "c1"},
                                       {"kind": "steer", "text": "only the logs bucket"}]
