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


def test_lifecycle_detail_surfaces_transitions_and_expiration():
    data = {"Rules": [
        {"ID": "archive-old", "Status": "Enabled", "Filter": {"Prefix": "logs/"},
         "Transitions": [{"Days": 30, "StorageClass": "GLACIER"}],
         "Expiration": {"Days": 365},
         "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 7}}]}
    r = ct._detail_lifecycle(data)[0]
    assert r["status"] == "Enabled" and r["prefix"] == "logs/"
    assert r["transitions"][0] == {"days": 30, "date": None, "storage_class": "GLACIER"}
    assert r["expiration_days"] == 365 and r["abort_incomplete_mpu_days"] == 7


def test_encryption_detail_reduces_kms_key():
    data = {"ServerSideEncryptionConfiguration": {"Rules": [
        {"ApplyServerSideEncryptionByDefault": {
            "SSEAlgorithm": "aws:kms",
            "KMSMasterKeyID": "arn:aws:kms:us-east-1:123456789012:key/abcd-1234"},
         "BucketKeyEnabled": True}]}}
    out = ct._detail_encryption(data)
    assert out[0]["sse_algorithm"] == "aws:kms" and out[0]["bucket_key_enabled"] is True
    assert "123456789012" not in json.dumps(out)  # account id stripped


def test_public_access_block_detail_surfaces_four_booleans():
    data = {"PublicAccessBlockConfiguration": {
        "BlockPublicAcls": True, "IgnorePublicAcls": True,
        "BlockPublicPolicy": False, "RestrictPublicBuckets": False}}
    assert ct._detail_pab(data)[0] == {
        "block_public_acls": True, "ignore_public_acls": True,
        "block_public_policy": False, "restrict_public_buckets": False}


def test_policy_detail_flags_public_without_leaking_principal():
    data = {"Policy": json.dumps({"Statement": [
        {"Sid": "PublicRead", "Effect": "Allow", "Principal": "*",
         "Action": ["s3:GetObject"], "Resource": "arn:aws:s3:::b/*"},
        {"Effect": "Allow", "Principal": {"AWS": "arn:aws:iam::123456789012:role/app"},
         "Action": "s3:PutObject", "Condition": {"IpAddress": {"aws:SourceIp": "10.0.0.0/8"}}},
    ]})}
    out = ct._detail_policy(data)
    assert out[0]["is_public"] is True and out[0]["principal"] == "*"
    assert out[0]["actions"] == ["s3:GetObject"]
    assert out[1]["principal"] == "specific" and out[1]["is_public"] is False
    assert out[1]["has_condition"] is True
    # Neither the account id nor the raw role ARN leaks (principal is summarized).
    assert "123456789012" not in json.dumps(out) and "role/app" not in json.dumps(out)


def test_inventory_detail_surfaces_schedule_and_destination():
    data = {"InventoryConfigurationList": [
        {"Id": "daily", "IsEnabled": True, "Schedule": {"Frequency": "Daily"},
         "IncludedObjectVersions": "Current",
         "Destination": {"S3BucketDestination": {
             "Bucket": "arn:aws:s3:::inv-dest", "Prefix": "inv/", "Format": "CSV"}},
         "OptionalFields": ["Size", "StorageClass"]}]}
    r = ct._detail_inventory(data)[0]
    assert r["enabled"] is True and r["schedule"] == "Daily"
    assert r["destination_bucket"] == "inv-dest" and r["destination_prefix"] == "inv/"
    assert r["format"] == "CSV" and "Size" in r["optional_fields"]


def test_website_detail_reduces_redirect_host_and_counts_rules():
    data = {"IndexDocument": {"Suffix": "index.html"},
            "ErrorDocument": {"Key": "error.html"},
            "RedirectAllRequestsTo": {"HostName": "example.com", "Protocol": "https"},
            "RoutingRules": [{"Redirect": {"HostName": "a"}}, {"Redirect": {"HostName": "b"}}]}
    r = ct._detail_website(data)[0]
    assert r["index_document"] == "index.html" and r["error_document"] == "error.html"
    assert r["redirect_all_to_host"] == "example.com" and r["redirect_protocol"] == "https"
    assert r["routing_rule_count"] == 2


def test_website_detail_empty_when_unconfigured():
    assert ct._detail_website({}) == []


def test_intelligent_tiering_detail_surfaces_tierings():
    data = {"IntelligentTieringConfigurationList": [
        {"Id": "cfg-1", "Status": "Enabled", "Filter": {"Prefix": "data/"},
         "Tierings": [{"Days": 90, "AccessTier": "ARCHIVE_ACCESS"},
                      {"Days": 180, "AccessTier": "DEEP_ARCHIVE_ACCESS"}]}]}
    r = ct._detail_intelligent_tiering(data)[0]
    assert r["status"] == "Enabled" and r["filter_prefix"] == "data/"
    assert r["tierings"][0] == {"days": 90, "access_tier": "ARCHIVE_ACCESS"}


def test_accelerate_detail_reports_status_or_empty():
    assert ct._detail_accelerate({"Status": "Enabled"})[0] == {"status": "Enabled"}
    assert ct._detail_accelerate({}) == []


def test_request_payment_detail_flags_requester_pays():
    assert ct._detail_request_payment({"Payer": "Requester"})[0]["requester_pays"] is True
    assert ct._detail_request_payment({"Payer": "BucketOwner"})[0]["requester_pays"] is False


def test_detail_aspects_and_extractors_stay_in_sync():
    # get_bucket_config_detail dispatches _DETAIL_EXTRACTORS[aspect]; a mismatch
    # would KeyError for a registered aspect. Guard the two dicts stay aligned.
    assert set(ct._DETAIL_ASPECTS) == set(ct._DETAIL_EXTRACTORS)


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
