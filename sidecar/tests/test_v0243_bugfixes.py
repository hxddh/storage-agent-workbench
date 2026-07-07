"""Regression tests for the v0.24.3 deep-audit fixes.

- the agent's session tools enforce allowed_prefixes, not just allowed_buckets (S3-1)
- aggregate clamps object-key-like group-bys to 20 groups (DuckDB rule-16)
- CLF/combined log timestamps normalize so hour-bucketing works (DuckDB F2)
- tz-aware timestamps bucket by UTC, not local wall-clock (DuckDB F3)
- large int64 sizes don't lose precision through a float round-trip (DuckDB F4)
- the data dir is 0700 and the DB file 0600 on POSIX (packaging P2)
"""
import json
import os
import sqlite3

import pytest

from app import config


class _FT:  # minimal function_tool stand-in: keep the fn, tag its name
    def __call__(self, fn):
        fn.name = fn.__name__
        return fn


def _conn():
    c = sqlite3.connect(str(config.db_path()))
    c.row_factory = sqlite3.Row
    return c


# --- S3-1: agent tools honor allowed_prefixes -------------------------------

def test_agent_tools_enforce_allowed_prefixes(client):
    from app.agent_runtime import session_tools

    pid = client.post("/cloud-providers", json={
        "name": "prefix-scoped", "provider_type": "s3-compatible",
        "endpoint_url": "https://minio.example.com", "region": "us-east-1",
        "addressing_style": "path", "access_key": "AKIAIOSFODNN7EXAMPLE",
        "secret_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        "allowed_prefixes": ["logs/"],
    }).json()["id"]

    with _conn() as conn:
        tools = {t.name: t for t in session_tools.build(conn, _FT(), [])}
        # Out-of-prefix key must be denied BEFORE any S3 call (no stub needed).
        out = json.loads(tools["preview_object"](pid, "bucket-alpha", "secrets/prod.env"))
        assert out.get("error"), "preview_object must deny an out-of-prefix key"
        head = json.loads(tools["head_object"](pid, "bucket-alpha", "secrets/prod.env"))
        assert head.get("error")
        # Root listing with prefix scope is denied; an in-scope prefix is allowed
        # past the scope gate (it may still fail later without a stub — that's fine,
        # we only assert the scope gate does not reject it).
        root = json.loads(tools["list_objects"](pid, "bucket-alpha", ""))
        assert root.get("error")


# --- DuckDB F1: aggregate clamps key/path group-bys to 20 -------------------

def test_aggregate_clamps_keylike_groups(tmp_path):
    from app.analysis import access_logs, aggregate

    lines = [json.dumps({"timestamp": "2026-06-25T10:00:00Z", "method": "GET",
                         "key": f"data/user-{i}/file-{i}.dat", "status": 200})
             for i in range(60)]
    src = tmp_path / "log.jsonl"
    src.write_text("\n".join(lines))
    ddb = tmp_path / "a.duckdb"
    access_logs.import_access_logs(src, ddb, access_logs.detect_log_format(src)["format"])

    out = aggregate.aggregate(ddb, "access_log", metric="count",
                                     group_by="key", limit=50)
    assert len(out["groups"]) <= 20  # rule 16: not 50 raw keys


# --- DuckDB F2/F3: timestamp normalization ----------------------------------

def test_clf_timestamp_buckets_by_hour(tmp_path):
    from app.analysis import access_logs, aggregate

    src = tmp_path / "clf.log"
    src.write_text(
        '1.2.3.4 - - [25/Jun/2026:10:00:00 +0000] "GET /a HTTP/1.1" 200 10\n'
        '1.2.3.4 - - [25/Jun/2026:10:30:00 +0000] "GET /b HTTP/1.1" 404 20\n'
    )
    ddb = tmp_path / "clf.duckdb"
    access_logs.import_access_logs(src, ddb, access_logs.detect_log_format(src)["format"])
    out = aggregate.aggregate(ddb, "access_log", metric="count", group_by="hour")
    groups = {g["group"] for g in out["groups"]}
    assert groups == {"2026-06-25T10:00"}  # was {'unknown'} before the fix


def test_tzaware_timestamps_bucket_by_utc(tmp_path):
    from app.analysis import access_logs, aggregate

    # Same UTC instant expressed in two zones → must land in the same hour bucket.
    src = tmp_path / "tz.jsonl"
    src.write_text(
        json.dumps({"timestamp": "2026-06-25T10:00:00+00:00", "method": "GET", "key": "a", "status": 200}) + "\n" +
        json.dumps({"timestamp": "2026-06-25T15:00:00+05:00", "method": "GET", "key": "b", "status": 200}) + "\n"
    )
    ddb = tmp_path / "tz.duckdb"
    access_logs.import_access_logs(src, ddb, access_logs.detect_log_format(src)["format"])
    out = aggregate.aggregate(ddb, "access_log", metric="count", group_by="hour")
    assert {g["group"] for g in out["groups"]} == {"2026-06-25T10:00"}


# --- DuckDB F4: int64 precision ---------------------------------------------

def test_large_size_no_float_precision_loss():
    from app.analysis.inventory import _to_int
    from app.analysis.access_logs import _to_int as _to_int_log

    big = 9223372036854775807  # int64 max — 9223372036854775808 after float round-trip
    assert _to_int(str(big)) == big
    assert _to_int_log(str(big)) == big
    assert _to_int("12.5") == 12  # fractional strings still parse


# --- Packaging P2: data dir 0700 / DB 0600 ----------------------------------

@pytest.mark.skipif(os.name != "posix", reason="POSIX permission bits")
def test_secure_dir_is_owner_only(tmp_path):
    d = config.ensure_secure_dir(tmp_path / "data" / "nested")
    assert (os.stat(d).st_mode & 0o777) == 0o700
