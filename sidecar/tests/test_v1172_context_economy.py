"""Context layers: compaction summary replaces earlier grounding, not stacks on it."""

from app.agent_runtime import compaction, prompt


def test_auto_compaction_leaves_headroom_for_the_next_turn():
    assert compaction.TRIGGER_RATIO == 0.6


def test_instructions_keep_every_safety_rule():
    for rule in prompt.SESSION_SAFETY_RULES:
        assert rule in prompt.INSTRUCTIONS
        assert rule in prompt.FINALIZE_INSTRUCTIONS
    assert len(prompt.FINALIZE_INSTRUCTIONS) < len(prompt.INSTRUCTIONS) * 0.7


def test_compaction_summary_replaces_summary_and_memory():
    facts = [{"text": f"fact {i}", "confidence": "high"} for i in range(40)]
    memory = [{"id": str(i), "kind": "fact", "text": f"mem {i}", "confidence": "high"}
              for i in range(40)]
    live = prompt.build_session_context(
        {"title": "t", "goal": "g", "status": "active"},
        {"known_facts": facts, "findings": [], "open_questions": [], "limitations": []},
        [{"role": "user", "content": "q", "seq": 10}],
        agent_memory=memory,
        active_skill={"name": "storageops-triage", "method": "M" * 4000,
                      "note": "do not read_skill it again"},
    )
    assert len(live["summary"]["known_facts"]) == 40
    assert len(live["agent_memory"]["recorded_facts"]) == 40
    assert live["active_skill"]["method"] == "M" * 4000

    compact = prompt.build_session_context(
        {"title": "t", "goal": "g", "status": "active"},
        {"known_facts": facts, "findings": [], "open_questions": [], "limitations": []},
        [{"role": "user", "content": "q", "seq": 10}],
        agent_memory=memory,
        active_skill={"name": "storageops-triage", "method": "M" * 4000,
                      "note": "do not read_skill it again"},
        compaction={"summary": "Earlier work established the bucket is private.",
                    "through_seq": 9},
    )
    assert compact["conversation_summary"].startswith("Earlier work")
    assert "summary" not in compact
    assert "agent_memory" not in compact
    assert compact["active_skill"]["name"] == "storageops-triage"
    assert "method" not in compact["active_skill"]
    assert "storage_task_context" not in compact

    grounded = prompt.build_session_context(
        {"title": "t", "goal": "g", "status": "active"},
        {"known_facts": facts, "findings": [], "open_questions": [], "limitations": []},
        [{"role": "user", "content": "q", "seq": 10}],
        agent_memory=memory,
        task_context={"schema_version": 1, "primary_bucket": "acme-logs",
                      "buckets_in_focus": ["acme-logs"]},
        compaction={"summary": "Earlier work established the bucket is private.",
                    "through_seq": 9},
    )
    assert "summary" not in grounded
    assert grounded["storage_task_context"]["primary_bucket"] == "acme-logs"
