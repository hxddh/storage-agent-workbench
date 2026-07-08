"""get_bucket_config_detail: surfaces the sanitized RULE detail (replication /
notification / cors / logging) that the review tools collapse to a status —
so the agent can read config the skills' decision trees need instead of asking
the user. Read-only, bounded (<=20 rules), ARNs reduced (no account id), redacted.
"""
import json
import sqlite3

from app.s3 import config_tools as ct


def test_arn_resource_strips_account_id_on_truncated_arn():
    """A standard 6-field ARN reduces to service:resource; a truncated / non-
    standard ARN (fewer fields, no resource) must still NEVER leak the account
    id — regression for the <6-part passthrough."""
    assert ct._arn_resource("arn:aws:sqs:us-east-1:123456789012:my-queue") == "sqs:my-queue"
    assert ct._arn_resource("arn:aws:s3:::my-bucket") == "my-bucket"
    # Truncated ARN with an account id but no resource segment: account stripped.
    reduced = ct._arn_resource("arn:aws:sns:us-east-1:123456789012")
    assert "123456789012" not in reduced
    assert reduced == "sns"


class _FT:
    def __call__(self, fn):
        fn.name = fn.__name__
        return fn


def test_replication_detail_reduces_arns_and_surfaces_rules():
    data = {"ReplicationConfiguration": {"Rules": [
        {"ID": "rule-1", "Status": "Enabled", "Priority": 1,
         "Filter": {"Prefix": "logs/"},
         "DeleteMarkerReplication": {"Status": "Disabled"},
         "Destination": {"Bucket": "arn:aws:s3:::dest-bucket", "StorageClass": "STANDARD"}},
    ]}}
    out = ct._detail_replication(data)
    assert len(out) == 1
    r = out[0]
    assert r["status"] == "Enabled"
    assert r["prefix"] == "logs/"
    assert r["delete_marker_replication"] == "Disabled"
    assert r["destination_bucket"] == "dest-bucket"  # ARN reduced to name


def test_notification_detail_strips_account_id_and_extracts_filter():
    data = {"QueueConfigurations": [
        {"QueueArn": "arn:aws:sqs:us-east-1:123456789012:my-queue",
         "Events": ["s3:ObjectCreated:*"],
         "Filter": {"Key": {"FilterRules": [{"Name": "prefix", "Value": "in/"},
                                            {"Name": "suffix", "Value": ".json"}]}}},
    ]}
    out = ct._detail_notification(data)
    assert len(out) == 1
    n = out[0]
    assert n["type"] == "queue"
    assert n["target"] == "sqs:my-queue"  # account id 123456789012 stripped
    assert "123456789012" not in json.dumps(out)  # no account id anywhere
    assert n["events"] == ["s3:ObjectCreated:*"]
    assert n["filter"] == {"prefix": "in/", "suffix": ".json"}


def test_cors_detail_surfaces_origins_methods():
    data = {"CORSRules": [
        {"AllowedOrigins": ["https://app.example.com"], "AllowedMethods": ["GET", "PUT"],
         "AllowedHeaders": ["*"], "MaxAgeSeconds": 3000}]}
    out = ct._detail_cors(data)
    assert out[0]["allowed_methods"] == ["GET", "PUT"]
    assert out[0]["allowed_origins"] == ["https://app.example.com"]


def test_detail_is_bounded_to_20_rules():
    data = {"CORSRules": [{"AllowedOrigins": [f"o{i}"], "AllowedMethods": ["GET"]}
                          for i in range(50)]}
    assert len(ct._detail_cors(data)) == 20


def test_unknown_aspect_rejected():
    out = ct.get_bucket_config_detail(sqlite3.connect(":memory:"), "pid", "b", "bogus")
    assert out["success"] is False and "unknown aspect" in out["error"]


def test_agent_tool_registered_and_scope_enforced(client):
    from app.agent_runtime import session_tools

    pid = client.post("/cloud-providers", json={
        "name": "scoped", "provider_type": "s3-compatible",
        "endpoint_url": "https://minio.example.com", "region": "us-east-1",
        "addressing_style": "path", "access_key": "AKIAIOSFODNN7EXAMPLE",
        "secret_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        "allowed_buckets": ["only-this"],
    }).json()["id"]
    conn = sqlite3.connect(str(__import__("app.config", fromlist=["config"]).db_path()))
    conn.row_factory = sqlite3.Row
    try:
        tools = {t.name: t for t in session_tools.build(conn, _FT(), [])}
        assert "get_bucket_config_detail" in tools
        # out-of-scope bucket is denied before any S3 call
        out = json.loads(tools["get_bucket_config_detail"](pid, "other-bucket", "cors"))
        assert out.get("error")
    finally:
        conn.close()
