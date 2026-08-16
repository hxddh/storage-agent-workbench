"""query_account_profile must not answer a posture question over buckets it
never established.

The filters are correct to EXCLUDE a bucket whose dimension was unreadable —
``access_denied`` on GetBucketEncryption is not evidence of missing encryption.
The defect was excluding it *silently*: the result carried only ``matched_count``
and ``total_buckets``, so "1 match out of 4 buckets" is the only thing the agent
can see, and it narrates an account-wide verdict ("only one bucket lacks
encryption") over two buckets nobody ever checked.

These tests pin the coverage accounting: every non-matching bucket is either
established or named in ``undetermined_buckets``.
"""
import json
import sqlite3

from app import config, db
from app.models.schemas import RunCreate
from app.repositories import account_discovery as account_repo
from app.repositories import runs as runs_repo

from .test_v0290_fixes import _provider


def _db():
    c = db.serialized(sqlite3.connect(str(config.db_path())))
    c.row_factory = sqlite3.Row
    return c


class _FT:
    def __call__(self, fn):
        fn.name = fn.__name__
        return fn


def _profile(conn, client, pid, ses, buckets):
    """Persist a completed survey whose per-bucket flags are ``buckets``."""
    from app.repositories import sessions as sessions_repo

    run_id = runs_repo.create(
        conn, RunCreate(run_type="account_discovery", provider_id=pid,
                        user_prompt="x", session_id=ses), status="completed")
    sid = account_repo.create_snapshot(conn, run_id, pid, bucket_count=len(buckets),
                                       visible_count=len(buckets),
                                       processed_count=len(buckets), truncated=False,
                                       list_status="available", summary={})
    for name, flags in buckets:
        account_repo.add_bucket(conn, sid, run_id, pid, name, "us-east-1", "available")
        account_repo.add_config_snapshot(conn, sid, run_id, pid, name, flags)
    sessions_repo.link_run(conn, ses, run_id, "account_discovery")
    conn.commit()
    return run_id


def _query(conn, ses, pid, filter_):
    from app.agent_runtime import session_action_tools
    tools = {t.name: t for t in session_action_tools.build(conn, _FT(), [], session_id=ses)}
    return json.loads(tools["query_account_profile"](pid, filter_))


def _session(client, pid):
    return client.post("/sessions",
                       json={"title": "t", "goal": "g", "provider_id": pid}).json()["id"]


def test_unreadable_dimension_is_named_not_silently_dropped(client):
    pid = _provider(client)
    ses = _session(client, pid)
    conn = _db()
    try:
        _profile(conn, client, pid, ses, [
            ("enc-on", {"encryption_status": "available"}),
            ("enc-off", {"encryption_status": "not_configured"}),
            ("enc-denied", {"encryption_status": "access_denied"}),
            ("enc-unsupported", {"encryption_status": "provider_unsupported"}),
        ])
        out = _query(conn, ses, pid, "missing_encryption")

        assert [b["bucket"] for b in out["buckets"]] == ["enc-off"]
        assert out["total_buckets"] == 4
        # The two unreadable buckets are neither matched nor treated as clean.
        assert out["undetermined_count"] == 2
        assert {(b["bucket"], b["status"]) for b in out["undetermined_buckets"]} == {
            ("enc-denied", "access_denied"),
            ("enc-unsupported", "provider_unsupported"),
        }
        # The model is told what the match count actually covers.
        assert "UNKNOWN" in out["coverage_note"]
        assert "2 established buckets" in out["coverage_note"]
    finally:
        conn.close()


def test_full_coverage_says_so_and_adds_no_caveat(client):
    """0 undetermined is a positive claim — the answer does cover the account."""
    pid = _provider(client)
    ses = _session(client, pid)
    conn = _db()
    try:
        _profile(conn, client, pid, ses, [
            ("a", {"lifecycle_status": "available"}),
            ("b", {"lifecycle_status": "not_configured"}),
        ])
        out = _query(conn, ses, pid, "missing_lifecycle")
        assert out["matched_count"] == 1
        assert out["undetermined_count"] == 0
        assert "coverage_note" not in out
        assert "undetermined_buckets" not in out
    finally:
        conn.close()


def test_public_buckets_needs_both_reads_to_call_a_bucket_private(client):
    """"Not public" is a verdict too. It requires the policy verdict AND the ACL
    read to have landed — a bucket with a non-public policy and an unreadable ACL
    is undetermined, not private."""
    pid = _provider(client)
    ses = _session(client, pid)
    conn = _db()
    try:
        _profile(conn, client, pid, ses, [
            ("open", {"publicly_exposed": True, "policy_is_public": True,
                      "policy_public_status": "available", "acl_status": "available"}),
            ("closed", {"publicly_exposed": False, "policy_is_public": False,
                        "acl_public": False, "policy_public_status": "available",
                        "acl_status": "available"}),
            ("acl-unreadable", {"policy_is_public": False,
                                "policy_public_status": "available",
                                "acl_status": "access_denied"}),
        ])
        out = _query(conn, ses, pid, "public_buckets")
        assert [b["bucket"] for b in out["buckets"]] == ["open"]
        assert [b["bucket"] for b in out["undetermined_buckets"]] == ["acl-unreadable"]
    finally:
        conn.close()


def test_all_filter_asserts_nothing_per_dimension(client):
    """'all' is a dump of the matrix, not a claim about any one dimension — it
    must not manufacture a caveat out of unreadable flags."""
    pid = _provider(client)
    ses = _session(client, pid)
    conn = _db()
    try:
        _profile(conn, client, pid, ses, [("a", {"encryption_status": "access_denied"})])
        out = _query(conn, ses, pid, "all")
        assert out["matched_count"] == 1
        assert out["undetermined_count"] == 0
    finally:
        conn.close()
