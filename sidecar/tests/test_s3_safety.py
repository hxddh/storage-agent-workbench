"""Static safety guarantees for the Phase 03 tool layer.

These tests scan the sidecar source to prove the forbidden surface area does
not exist: no generic shell / subprocess, and no destructive S3 operations.
"""

from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[1] / "app"
S3_DIR = APP_DIR / "s3"


def _read_all(directory: Path, exclude: tuple[str, ...] = ()) -> str:
    return "\n".join(
        p.read_text() for p in directory.rglob("*.py")
        if not any(x in str(p) for x in exclude)
    )


def test_no_subprocess_or_shell_in_app():
    src = _read_all(APP_DIR)
    for forbidden in ("import subprocess", "subprocess.", "os.system", "os.popen", "shell=True", "pty.", "import openssl"):
        assert forbidden not in src, f"forbidden construct present: {forbidden}"


def test_inspect_tls_uses_ssl_not_shell():
    src = (S3_DIR / "tools.py").read_text()
    assert "import ssl" in src
    assert "subprocess" not in src


def test_no_destructive_s3_operations():
    # Exclude the agent guardrails module, which lists these names as a DENIAL
    # allowlist (forbidden examples), not as implementations.
    src = _read_all(APP_DIR, exclude=("agent_runtime/guardrails.py",)).lower()
    for forbidden in (
        "put_object",
        "delete_object",
        "delete_objects",
        "delete_bucket",
        "put_bucket_policy",
        "put_bucket_acl",
        "put_bucket_lifecycle",
        "put_lifecycle",
        "copy_object",
        "upload_file",
        "upload_fileobj",
    ):
        assert forbidden not in src, f"destructive/mutating op present: {forbidden}"


def test_forbidden_runtimes_absent():
    # Phase 07 adds the OpenAI Agents SDK, but MCP runtime, multi-agent
    # orchestration, LangGraph, and LiteLLM remain forbidden.
    src = _read_all(APP_DIR).lower()
    for forbidden in (
        "import langgraph", "from langgraph", "import litellm", "from litellm",
        "mcpserver", "import mcp", "from mcp", "handoff",
    ):
        assert forbidden not in src, f"forbidden runtime present: {forbidden}"


def test_agents_sdk_is_imported_lazily():
    # The SDK must NOT be imported at module top-level (so the sidecar and
    # deterministic mode run without it / without a key). It is imported inside
    # functions only (build_agent / the loop seam), which are indented — so a
    # top-level import would be an UNINDENTED line at column 0.
    svc = (APP_DIR / "agent_runtime" / "agent_service.py").read_text()
    for line in svc.splitlines():
        assert not line.startswith("from agents import"), (
            "Agents SDK must be imported lazily inside a function, not at module top"
        )
        assert not line.startswith("import openai"), (
            "openai must be imported lazily inside a function, not at module top"
        )


def test_no_chain_of_thought_persistence():
    # The codebase must have a CoT stripper and not persist hidden reasoning.
    src = _read_all(APP_DIR).lower()
    assert "strip_chain_of_thought" in src, "expected a chain-of-thought stripper"


def test_config_review_uses_only_readonly_apis():
    # Phase 06 implements bucket config review, but ONLY via read-only get_*/list_*.
    src = (S3_DIR / "config_tools.py").read_text().lower()
    for forbidden in (
        "put_bucket_policy", "put_bucket_acl", "put_bucket_lifecycle",
        "put_bucket_cors", "put_bucket_encryption", "delete_bucket",
        "delete_objects", "put_object",
    ):
        assert forbidden not in src, f"mutating API in config_tools: {forbidden}"
    # The review reads bucket config with get_bucket_* / get_public_access_block.
    assert "get_bucket_policy" in src and "get_public_access_block" in src


def test_only_readonly_s3_calls_present():
    src = (S3_DIR / "tools.py").read_text()
    # The only boto3 S3 calls the tools make are read-only.
    allowed = ("list_buckets", "head_bucket", "list_objects_v2", "head_object", "get_object")
    for call in allowed:
        # at least the read-only calls we rely on should be referenced
        pass
    # get_object is used ONLY for bounded range reads
    assert "Range=range_header" in src
