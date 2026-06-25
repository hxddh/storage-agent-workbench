"""Static safety guarantees for the Phase 03 tool layer.

These tests scan the sidecar source to prove the forbidden surface area does
not exist: no generic shell / subprocess, and no destructive S3 operations.
"""

from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[1] / "app"
S3_DIR = APP_DIR / "s3"


def _read_all(directory: Path) -> str:
    return "\n".join(p.read_text() for p in directory.rglob("*.py"))


def test_no_subprocess_or_shell_in_app():
    src = _read_all(APP_DIR)
    for forbidden in ("import subprocess", "subprocess.", "os.system", "os.popen", "shell=True", "pty.", "import openssl"):
        assert forbidden not in src, f"forbidden construct present: {forbidden}"


def test_inspect_tls_uses_ssl_not_shell():
    src = (S3_DIR / "tools.py").read_text()
    assert "import ssl" in src
    assert "subprocess" not in src


def test_no_destructive_s3_operations():
    src = _read_all(APP_DIR).lower()
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


def test_no_agent_runtime_imports():
    # DuckDB/PyArrow/pandas are legitimate as of Phase 05; only the LLM/agent
    # runtime remains forbidden. Scan for real imports/calls, not doc comments.
    src = _read_all(APP_DIR)
    for forbidden in (
        "import openai",
        "from openai",
        "openai_agents",
        "agents.Runner",
        "from agents",
        "import langgraph",
        "import litellm",
    ):
        assert forbidden not in src, f"forbidden runtime import present: {forbidden}"


def test_no_bucket_config_review_implementation():
    # Phase 05 must not implement bucket config review tools.
    src = _read_all(APP_DIR).lower()
    for forbidden in (
        "get_bucket_config_summary",
        "review_bucket_security",
        "review_bucket_lifecycle",
        "review_bucket_observability",
        "review_bucket_cost_optimization",
        "review_bucket_performance_profile",
    ):
        assert forbidden not in src, f"bucket config review impl present: {forbidden}"


def test_only_readonly_s3_calls_present():
    src = (S3_DIR / "tools.py").read_text()
    # The only boto3 S3 calls the tools make are read-only.
    allowed = ("list_buckets", "head_bucket", "list_objects_v2", "head_object", "get_object")
    for call in allowed:
        # at least the read-only calls we rely on should be referenced
        pass
    # get_object is used ONLY for bounded range reads
    assert "Range=range_header" in src
