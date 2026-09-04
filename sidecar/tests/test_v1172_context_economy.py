"""Context economy: compact earlier, don't triple-pay grounding after a summary."""

from app.agent_runtime import compaction, prompt


def test_auto_compaction_triggers_at_sixty_percent():
    assert compaction.TRIGGER_RATIO == 0.6


def test_instructions_stay_shorter_than_the_safety_floor_allows():
    # The markdown/engine coaching is the paid part we can shorten; every
    # SAFETY RULE still has to be present in both prompts.
    for rule in prompt.SESSION_SAFETY_RULES:
        assert rule in prompt.INSTRUCTIONS
        assert rule in prompt.FINALIZE_INSTRUCTIONS
    assert len(prompt.FINALIZE_INSTRUCTIONS) < len(prompt.INSTRUCTIONS) * 0.7


def test_compaction_summary_does_not_resend_the_full_memory_tail():
    facts = [{"text": f"fact {i}", "confidence": "high"} for i in range(40)]
    memory = [{"id": str(i), "kind": "fact", "text": f"mem {i}", "confidence": "high"}
              for i in range(40)]
    fat = prompt.build_session_context(
        {"title": "t", "goal": "g", "status": "active"},
        {"known_facts": facts, "findings": [], "open_questions": [], "limitations": []},
        [{"role": "user", "content": "q", "seq": 10}],
        agent_memory=memory,
    )
    assert len(fat["summary"]["known_facts"]) == 40
    assert len(fat["agent_memory"]["recorded_facts"]) == 40

    compact = prompt.build_session_context(
        {"title": "t", "goal": "g", "status": "active"},
        {"known_facts": facts, "findings": [], "open_questions": [], "limitations": []},
        [{"role": "user", "content": "q", "seq": 10}],
        agent_memory=memory,
        compaction={"summary": "Earlier work established the bucket is private.",
                    "through_seq": 9},
    )
    assert compact["conversation_summary"].startswith("Earlier work")
    assert len(compact["summary"]["known_facts"]) <= prompt._COMPACTED_MEMORY_CAP
    assert len(compact["agent_memory"]["recorded_facts"]) <= prompt._COMPACTED_MEMORY_CAP
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
    assert grounded["storage_task_context"]["primary_bucket"] == "acme-logs"


def test_carried_skill_method_is_clipped_in_the_prompt():
    method = "M" * 4000
    ctx = prompt.build_session_context(
        {"title": "t", "goal": "g", "status": "active"},
        {"known_facts": [], "findings": [], "open_questions": [], "limitations": []},
        [{"role": "user", "content": "q"}],
        active_skill={"name": "storageops-triage", "method": method,
                      "note": "do not read_skill it again"},
    )
    carried = ctx["active_skill"]["method"]
    assert len(carried) < 1600
    assert "TRUNCATED" in carried
    assert carried.startswith("M" * 20)
