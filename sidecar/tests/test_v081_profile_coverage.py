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


# ------------------------------------------------------------------ diff -----
# Same defect class in the sibling tool: compare_to_last_survey answered "what
# changed" over an account it had only partly seen. A survey that stopped at its
# bucket cap did not observe the buckets past it, so a bucket present in the
# older survey and absent from the truncated newer one came back as a flat
# `bucket_removed` — the agent reports a deletion for a bucket that still
# exists. The output even carried `truncated: false` alongside it (that flag is
# about the CHANGES LIST being capped, a different subject entirely).


def _survey(conn, pid, ses, names, truncated):
    from app.repositories import sessions as sessions_repo
    run_id = runs_repo.create(
        conn, RunCreate(run_type="account_discovery", provider_id=pid,
                        user_prompt="x", session_id=ses), status="completed")
    sid = account_repo.create_snapshot(conn, run_id, pid, bucket_count=len(names),
                                       visible_count=len(names),
                                       processed_count=len(names), truncated=truncated,
                                       list_status="available", summary={})
    for n in names:
        account_repo.add_bucket(conn, sid, run_id, pid, n, "us-east-1", "available")
        account_repo.add_config_snapshot(conn, sid, run_id, pid, n,
                                         {"encryption_status": "available"})
    sessions_repo.link_run(conn, ses, run_id, "account_discovery")
    conn.commit()
    return run_id


def _compare(conn, ses, pid):
    from app.agent_runtime import session_action_tools
    tools = {t.name: t for t in session_action_tools.build(conn, _FT(), [], session_id=ses)}
    return json.loads(tools["compare_to_last_survey"](pid))


def test_truncated_newer_survey_does_not_report_deletions_as_fact(client):
    pid = _provider(client)
    ses = _session(client, pid)
    conn = _db()
    try:
        _survey(conn, pid, ses, ["b1", "b2", "b3", "b4", "b5"], False)
        _survey(conn, pid, ses, ["b1", "b2", "b3"], True)  # capped at 3
        out = _compare(conn, ses, pid)

        removed = [c for c in out["changes"] if c["change"] == "bucket_removed"]
        assert [c["bucket"] for c in removed] == ["b4", "b5"]
        assert all(c.get("unverified") is True for c in removed)
        assert all("not have been scanned" in c["note"] for c in removed)
        # The caller can see which survey was partial, and how partial.
        assert out["surveys_truncated"] == {"older": False, "newer": True}
        assert out["newer_survey"]["truncated"] is True
        assert out["newer_survey"]["buckets_seen"] == 3
        assert out["older_survey"]["buckets_seen"] == 5
        assert "not see the whole account" in out["coverage_note"]
    finally:
        conn.close()


def test_truncated_older_survey_does_not_report_additions_as_fact(client):
    """The mirror case: a bucket absent from a capped older survey is not new."""
    pid = _provider(client)
    ses = _session(client, pid)
    conn = _db()
    try:
        _survey(conn, pid, ses, ["b1", "b2"], True)  # capped at 2
        _survey(conn, pid, ses, ["b1", "b2", "b3"], False)
        out = _compare(conn, ses, pid)
        added = [c for c in out["changes"] if c["change"] == "bucket_added"]
        assert [c["bucket"] for c in added] == ["b3"]
        assert added[0]["unverified"] is True
        assert out["surveys_truncated"] == {"older": True, "newer": False}
    finally:
        conn.close()


def test_two_complete_surveys_assert_membership_changes_plainly(client):
    """When both surveys saw the whole account, a removal IS a removal — the new
    caveat must not water down a real finding."""
    pid = _provider(client)
    ses = _session(client, pid)
    conn = _db()
    try:
        _survey(conn, pid, ses, ["b1", "b2"], False)
        _survey(conn, pid, ses, ["b1"], False)
        out = _compare(conn, ses, pid)
        removed = [c for c in out["changes"] if c["change"] == "bucket_removed"]
        assert [c["bucket"] for c in removed] == ["b2"]
        assert "unverified" not in removed[0]
        assert out["surveys_truncated"] == {"older": False, "newer": False}
        assert "coverage_note" not in out
    finally:
        conn.close()
