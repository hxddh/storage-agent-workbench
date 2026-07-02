"""Tests for Phase 4: graded list escalation + token-precise forbidden matching.

The 100-key cap is now a soft DEFAULT, not a silent ceiling — a deliberate
larger request is honored up to the bounded MAX (== the S3 hard cap). The
forbidden-tool check matches whole name tokens, so legitimate read-only tools
are not falsely blocked by an incidental substring; real dangers still are.
"""

from app.agent_runtime import guardrails as g


# --- graded list escalation -------------------------------------------------


def test_list_default_when_unset():
    assert g.bound_tool_args("list_objects_v2", {})["max_keys"] == g.AGENT_DEFAULT_LIST_KEYS == 100


def test_explicit_larger_request_is_honored_not_dropped_to_default():
    # The old behavior clamped any agent request down to 100; now a deliberate
    # 500 survives (bounded by the 1000 ceiling).
    assert g.bound_tool_args("list_objects_v2", {"max_keys": 500})["max_keys"] == 500


def test_request_above_ceiling_is_clamped_to_max():
    assert g.bound_tool_args("list_objects_v2", {"max_keys": 999999})["max_keys"] == g.AGENT_MAX_LIST_KEYS == 1000


# Note: there is no `approval_category` gate — a request above the ceiling is
# CLAMPED (bounds, not gates), never converted into a human-approval requirement.


# --- token-precise forbidden matching --------------------------------------


def test_real_dangers_still_forbidden():
    for name in ("shell", "run_bash", "subprocess_run", "exec_code", "eval",
                 "boto3_client", "raw_client", "run_sql", "sql_query",
                 "put_object", "delete_objects", "delete_bucket",
                 "put_bucket_policy", "copy_object", "upload_file", "create_bucket"):
        assert g.is_forbidden_tool(name), f"should be forbidden: {name}"


def test_legitimate_readonly_tools_not_falsely_forbidden():
    # These were at risk under the old substring match ("sh" in refresh, "code"
    # in error_code, "client" substring, "query" substring, etc.).
    for name in ("test_credentials", "inspect_endpoint_tls", "refresh_status",
                 "get_error_code", "head_object", "list_objects", "head_bucket",
                 "test_addressing_style", "review_bucket_security",
                 "get_bucket_config_summary", "read_skill"):
        assert not g.is_forbidden_tool(name), f"should NOT be forbidden: {name}"


def test_put_or_delete_alone_not_forbidden_only_the_op_phrase():
    # "put"/"delete"/"create" as standalone verbs aren't blocked wholesale —
    # only the actual mutating op phrases are.
    assert not g.is_forbidden_tool("put_dataset_label")
    assert g.is_forbidden_tool("s3_put_object")


# --- chain-of-thought stripping --------------------------------------------


def test_strip_removes_both_think_and_thinking_blocks():
    # Both spellings of paired hidden-reasoning blocks are removed entirely,
    # keeping the surrounding answer text.
    out = g.strip_chain_of_thought(
        "Before.<think>secret plan A</think> Middle. "
        "<thinking>\nsecret plan B\n</thinking> After."
    )
    assert "secret plan" not in out
    assert "Before." in out and "Middle." in out and "After." in out


def test_strip_does_not_truncate_answer_that_mentions_reasoning():
    # A legit answer that merely contains "Reasoning:" mid-text must survive
    # intact (the old code chopped everything after the first marker).
    answer = "The bucket is public. Reasoning: the ACL grants READ to AllUsers."
    assert g.strip_chain_of_thought(answer) == answer


def test_strip_drops_leading_cot_preamble_up_to_answer():
    text = (
        "Reasoning: first I check the ACL, then the policy.\n"
        "Answer: the bucket is public."
    )
    out = g.strip_chain_of_thought(text)
    assert out == "the bucket is public."
    assert "Reasoning" not in out


def test_strip_drops_leading_cot_preamble_up_to_blank_line():
    text = "Chain of thought: I inspect the config.\n\nThe bucket is private."
    out = g.strip_chain_of_thought(text)
    assert out == "The bucket is private."
