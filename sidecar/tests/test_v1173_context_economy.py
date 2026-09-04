"""Context economy: engines gated, first delivery digested, prefix kept small."""

from __future__ import annotations

import asyncio
import json
import sqlite3

from agents import function_tool

from app import db, migrations
from app.agent_runtime import prompt
from app.agent_runtime import session_agent as sa


def test_engine_tools_are_gated_not_core():
    engines = {
        "simulate_storage_cost", "draft_remediation_plan", "verify_remediation_plan",
        "capture_task_baseline", "compare_task_drift", "get_price_table_status",
        "set_task_revisit_days",
    }
    assert engines.isdisjoint(sa._CORE_TOOLS)
    for name in engines:
        assert sa._GROUP_OF_TOOL[name] == "storage_engines"
    assert "storage_engines" in sa._TOOL_GROUPS
    assert "storage_engines" in sa.INSTRUCTIONS
    assert "storage_engines" in sa.tool_group_catalog()


def test_compact_after_one_step_and_first_delivery_bound():
    assert sa._COMPACT_AFTER_STEPS == 1
    assert sa._FIRST_DELIVERY_CHARS == 6000
    assert sa._MAX_TOOL_OUTPUT_CHARS == 48_000
    assert sa._TOOL_DESC_LIMIT == 240
    assert "read_skill" in sa._FIRST_DELIVERY_EXEMPT


def test_first_delivery_digests_a_large_json_listing():
    keys = [f"logs/2026/08/{i:04d}.log" for i in range(400)]
    payload = json.dumps({"success": True, "keys": keys, "is_truncated": True,
                          "key_count": 400})
    wrapped = f"{sa._UNTRUSTED_OPEN}\n{payload}\n{sa._UNTRUSTED_CLOSE}"
    out = sa._first_delivery_digest(wrapped)
    assert "keys_count" in out
    assert "logs/2026/08/0000.log" not in out
    assert "BOUNDED" in out
    assert out.startswith(sa._UNTRUSTED_OPEN)
    assert sa._UNTRUSTED_CLOSE in out


def test_first_delivery_is_applied_before_the_model_sees_the_payload():
    class _Tool:
        name = "list_objects"

        async def on_invoke_tool(self, _ctx, _args):
            keys = [f"obj-{i:04d}" for i in range(500)]
            return json.dumps({"success": True, "keys": keys, "key_count": 500})

    t = _Tool()
    sa._install_tool_output_budget([t], limit=200_000, token_limit=1_000_000)
    text = asyncio.run(t.on_invoke_tool(None, "{}"))
    assert "keys_count" in text
    assert "BOUNDED" in text
    assert "obj-0000" not in text
    assert len(text) < sa._FIRST_DELIVERY_CHARS


def test_read_skill_is_not_digested_on_first_delivery():
    body = "M" * (sa._FIRST_DELIVERY_CHARS + 500)

    class _Tool:
        name = "read_skill"

        async def on_invoke_tool(self, _ctx, _args):
            return body

    t = _Tool()
    sa._install_tool_output_budget([t], limit=200_000, token_limit=1_000_000)
    text = asyncio.run(t.on_invoke_tool(None, "{}"))
    assert text == body
    assert "BOUNDED" not in text


def test_tool_descriptions_are_shortened_to_one_sentence():
    class _Tool:
        name = "list_objects"
        description = (
            "List object keys under a prefix. Returns a page of keys with "
            "continuation and never treats key_count as the bucket total, "
            "which is why a second sentence is here at all: the schema "
            "already names every parameter and this prose was being re-sent "
            "on every step of every turn. "
            "Args: provider_id, bucket, prefix, max_keys, continuation_token."
        )

    t = _Tool()
    assert len(t.description) > sa._TOOL_DESC_LIMIT
    assert sa._shorten_tool_descriptions([t]) == 1
    assert t.description.startswith("List object keys under a prefix.")
    assert "Args:" in t.description
    assert "second sentence" not in t.description
    assert len(t.description) <= sa._TOOL_DESC_LIMIT + 80


def test_instructions_keep_every_safety_rule_and_every_group():
    for rule in prompt.SESSION_SAFETY_RULES:
        assert rule in prompt.INSTRUCTIONS
        assert rule in prompt.FINALIZE_INSTRUCTIONS
    assert "load_tools" in prompt.INSTRUCTIONS
    for group in sa._TOOL_GROUPS:
        assert group in prompt.INSTRUCTIONS
    assert len(prompt.FINALIZE_INSTRUCTIONS) < len(prompt.INSTRUCTIONS) * 0.7
    assert len(sa.tool_group_catalog()) < 1200


def test_core_wire_stays_well_under_the_old_prefix():
    c = db.serialized(sqlite3.connect(":memory:", check_same_thread=False))
    c.row_factory = sqlite3.Row
    migrations.apply_migrations(c)
    unlocked: set[str] = set()
    tools = sa._build_tools(c, function_tool, [], "s1", "t1", None,
                            model="gpt-4o", unlocked=unlocked)
    tools.append(sa._build_load_tools(function_tool, unlocked, []))
    sa._install_tool_gating(tools, unlocked)
    sa._strip_schema_titles(tools)
    sa._shorten_tool_descriptions(tools)
    total = 0
    for t in tools:
        enabled = getattr(t, "is_enabled", True)
        if callable(enabled) and not enabled(None, None):
            continue
        total += len(json.dumps(
            {"type": "function", "function": {
                "name": t.name, "description": t.description,
                "parameters": t.params_json_schema}}, separators=(",", ":")))
        desc = t.description or ""
        assert len(desc) <= 900, t.name
    # 22 CORE schemas were ~11k chars. 15 shortened CORE tools must stay
    # well under that so the per-step prefix actually shrinks.
    assert total < 12_000, total
    c.close()
