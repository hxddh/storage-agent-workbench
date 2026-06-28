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


def test_full_scan_above_ceiling_requires_approval():
    assert g.approval_category("list_objects_v2", {"max_keys": 5000}) == g.APPROVAL_REQUIRED
    assert g.approval_category("list_objects_v2", {"max_keys": 1000}) == g.NO_APPROVAL_REQUIRED


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
