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
