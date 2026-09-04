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


def test_summary_does_not_restack_facts_already_in_memory():
    live = prompt.build_session_context(
        {"title": "t", "goal": "g", "status": "active"},
        {"known_facts": [{"text": "bucket acme-logs is private", "confidence": "high"}],
         "findings": [{"title": "public ACL", "interpretation": "x", "severity": "high"}],
         "open_questions": ["who owns the key?"], "limitations": ["no inventory"]},
        [{"role": "user", "content": "q"}],
        agent_memory=[
            {"id": "1", "kind": "fact", "text": "bucket acme-logs is private"},
            {"id": "2", "kind": "finding", "text": "public ACL"},
        ],
    )
    assert live["agent_memory"]["recorded_facts"][0]["id"] == "1"
    assert live["summary"]["known_facts"] == []
    assert live["summary"]["findings"] == []
    assert live["summary"]["open_questions"] == ["who owns the key?"]
    assert live["summary"]["limitations"] == ["no inventory"]


def test_assistant_replay_is_a_digest_user_direction_stays_full():
    direction = "D" * 900
    answer = "A" * 4000
    ctx = prompt.build_session_context(
        {"title": "t", "goal": "g", "status": "active"},
        {"known_facts": [], "findings": [], "open_questions": [], "limitations": []},
        [{"role": "user", "content": direction},
         {"role": "assistant", "content": answer,
          "tool_activity": [{"tool": "head_bucket", "target": "b",
                             "result": "ok", "status": "completed"}]}],
    )
    user = ctx["recent_messages"][0]
    asst = ctx["recent_messages"][1]
    assert user["content"] == direction
    assert len(asst["content"]) < 800
    assert "TRUNCATED" in asst["content"]
    assert asst["tools_run"][0].startswith("head_bucket")


def test_empty_memory_is_omitted_not_sent_as_empty_lists():
    ctx = prompt.build_session_context(
        {"title": "t", "goal": "g", "status": "active"},
        {"known_facts": [{"text": "only the engine knows this"}],
         "findings": [], "open_questions": [], "limitations": []},
        [],
        agent_memory=[],
    )
    assert "agent_memory" not in ctx
    assert ctx["summary"]["known_facts"][0]["text"] == "only the engine knows this"


def test_prompt_does_not_restack_the_answer_shape_after_the_direction():
    text, _, _ = prompt._build_prompt(
        {"title": "t", "goal": "g", "status": "active", "id": None},
        {"known_facts": [], "findings": [], "open_questions": [], "limitations": []},
        [],
        "why is the bucket large?",
        conn=None,
    )
    assert text.endswith("Direction:\nwhy is the bucket large?")
    assert "Write your FULL answer as Markdown prose" not in text


def test_run_groups_prompt_cache_by_task_id():
    from app.agent_runtime import session_agent as sa
    src = open(sa.__file__).read()
    assert "group_id=spec.get(\"session_id\")" in src
    assert "OpenAIResponsesCompactionSession" in src
    assert "Chat Completions" in src
