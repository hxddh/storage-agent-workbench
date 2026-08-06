"""v0.57.0 — stop re-sending output the agent already read.

After v0.56.0 the same 8-tool turn costs 94,817 input tokens, and the split has
flipped: the fixed prefix is 34% and TOOL OUTPUTS are 33% — no longer a distant
third. Splitting that 33% on the measured turn:

    first delivery of each result       23,100 chars    5,775 tok
    RE-SENDS of consumed output        100,900 chars   25,225 tok  = 81%

An 8,000-char skill body or a 1000-key listing read at step 3 is re-sent at full
price on steps 4 through 9. v0.54.0 deferred this as "riskier, wants its own
release" because it meant rewriting history; the SDK's own
`RunConfig.call_model_input_filter` hands the input list over and takes it back
modified, which is what makes it safe to do.
"""

from __future__ import annotations

from app.agent_runtime import session_agent as sa

O, C = sa._UNTRUSTED_OPEN, sa._UNTRUSTED_CLOSE


def _out(cid: str, payload: str, wrapped: bool = True) -> dict:
    body = f"{O}\n{payload}\n{C}" if wrapped else payload
    return {"type": "function_call_output", "call_id": cid, "output": body}


def _turn(sizes: list[int]) -> list[dict]:
    items: list[dict] = [{"type": "message", "role": "user", "content": "why so large?"}]
    for i, n in enumerate(sizes):
        items.append({"type": "function_call", "call_id": f"c{i}",
                      "name": "list_objects", "arguments": "{}"})
        items.append(_out(f"c{i}", "K" * n))
    return items


def test_an_old_large_result_is_reduced():
    items = _turn([4000, 3000, 8000, 2000, 1200, 900, 1500, 2500])
    before = sum(len(i.get("output", "")) for i in items)
    new, reclaimed = sa._compact_consumed_outputs(items)
    after = sum(len(i.get("output", "")) for i in new)
    assert reclaimed > 0 and before - after == reclaimed
    assert after < before * 0.55, f"{before} -> {after}"


def test_the_most_recent_results_are_never_touched():
    items = _turn([4000, 4000, 4000, 4000])
    new, _ = sa._compact_consumed_outputs(items)
    outs = [i for i in new if i["type"] == "function_call_output"]
    # The agent is actively reasoning about these; compacting them would take
    # away the very data the next step is about to use.
    for recent in outs[-sa._COMPACT_AFTER_STEPS:]:
        assert "COMPACTED" not in recent["output"]
    assert "COMPACTED" in outs[0]["output"]


def test_the_cut_is_stated_never_silent():
    items = _turn([9000, 100, 100])
    new, _ = sa._compact_consumed_outputs(items)
    first = [i for i in new if i["type"] == "function_call_output"][0]["output"]
    # A compacted listing that looked complete would be reported as the whole
    # bucket. Same rule as every other bound in this product.
    assert "COMPACTED" in first
    assert "characters of it were dropped" in first
    assert "call the tool again" in first


def test_the_untrusted_envelope_survives_compaction():
    items = _turn([9000, 100, 100])
    new, _ = sa._compact_consumed_outputs(items)
    first = [i for i in new if i["type"] == "function_call_output"][0]["output"]
    # The surviving head is still third-party data and must still say so (SEC4);
    # the accounting line is runtime text and sits outside the envelope.
    assert first.startswith(O)
    assert C in first
    assert first.rindex(C) < first.index("[COMPACTED")


def test_the_head_of_the_payload_survives():
    marker = "FIRSTKEY-logs/2026/08/05/app.log"
    items = [_out("a", marker + "Z" * 9000), _out("b", "x"), _out("c", "y")]
    new, _ = sa._compact_consumed_outputs(items)
    # A listing's first entries are usually the part being reasoned about.
    assert marker in new[0]["output"]


def test_a_small_result_is_left_alone():
    items = [_out("a", "tiny"), _out("b", "x"), _out("c", "y")]
    new, reclaimed = sa._compact_consumed_outputs(items)
    assert reclaimed == 0 and new == items


def test_nothing_but_tool_results_is_modified():
    items = _turn([9000, 100, 100])
    new, _ = sa._compact_consumed_outputs(items)
    assert len(new) == len(items)
    for a, b in zip(items, new):
        if a.get("type") != "function_call_output":
            assert a is b, "a non-result item was rewritten"
        assert a.get("type") == b.get("type")
        assert a.get("call_id") == b.get("call_id")


def test_a_turn_too_short_to_have_consumed_anything_is_untouched():
    items = [_out("a", "Z" * 9000)]
    new, reclaimed = sa._compact_consumed_outputs(items)
    assert reclaimed == 0 and new is items


def test_an_unwrapped_payload_gains_no_stray_markers():
    items = [_out("a", "Z" * 9000, wrapped=False), _out("b", "x"), _out("c", "y")]
    new, reclaimed = sa._compact_consumed_outputs(items)
    assert reclaimed > 0
    assert O not in new[0]["output"] and C not in new[0]["output"]


# --- the filter itself -------------------------------------------------------


def _call_data(items, instructions="INSTR"):
    from agents.run import CallModelData, ModelInputData
    return CallModelData(model_data=ModelInputData(input=items, instructions=instructions),
                         agent=None, context=None)


def test_the_filter_returns_the_shape_the_sdk_expects():
    from agents.run import ModelInputData
    stats: dict = {}
    out = sa._make_input_filter(stats)(_call_data(_turn([9000, 100, 100])))
    assert isinstance(out, ModelInputData)
    assert out.instructions == "INSTR"
    assert stats["compacted_chars"] > 0


def test_the_filter_reports_nothing_when_there_is_nothing_to_reclaim():
    stats: dict = {}
    sa._make_input_filter(stats)(_call_data([_out("a", "tiny")]))
    assert stats == {}


def test_the_filter_never_breaks_a_turn():
    stats: dict = {}
    f = sa._make_input_filter(stats)
    # A malformed item must cost the optimization, never the turn.
    assert f(_call_data([{"type": "function_call_output"}, None, 7])) is not None


# --- the tool-less finalize pass --------------------------------------------


def test_the_finalize_pass_drops_instructions_it_cannot_act_on():
    assert len(sa.FINALIZE_INSTRUCTIONS) < len(sa.INSTRUCTIONS) * 0.7
    for gone in ("load_tools", "object_forensics", "compare_to_last_survey"):
        assert gone not in sa.FINALIZE_INSTRUCTIONS


def test_the_finalize_pass_keeps_every_safety_rule():
    # A shorter prompt is never a reason to relax a safety rule.
    for rule in sa.SESSION_SAFETY_RULES:
        assert rule in sa.FINALIZE_INSTRUCTIONS


def test_the_finalize_pass_still_knows_how_to_write_the_answer():
    for kept in ("markdown", "FIRST column", "next step"):
        assert kept in sa.FINALIZE_INSTRUCTIONS
    # And it is told the thing only IT needs to know.
    assert "No further tools are available" in sa.FINALIZE_INSTRUCTIONS
