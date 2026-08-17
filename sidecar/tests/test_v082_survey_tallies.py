"""The account survey's per-dimension tallies must account for every bucket.

Public exposure already got the careful treatment: three outcomes, and an
explicit "this is NOT the same as 'not public'". Encryption did not. On an
account where GetBucketEncryption comes back access_denied, the survey reported

    Encryption configured 1 | not configured 1 | provider-unsupported 1

over FOUR buckets. The denied one appeared in no count, no finding, and no note
— so "1 bucket has no default encryption" reads as a verdict on all four, and
the reader totalling the rows cannot see that one is simply unknown.

These tests pin the arithmetic: for each dimension, configured + not_configured
+ unsupported + undetermined == processed buckets.
"""
import pytest

from tests.test_account_discovery import (FakeS3, _cerr, _provider, _run_discovery,
                                          _use_fake, sync_runs)  # noqa: F401

_DIMENSIONS = ("encryption", "logging", "inventory", "lifecycle", "public_access_block")


def _mixed_survey(client, monkeypatch, method):
    """A 4-bucket account where one read is denied and one is unsupported."""
    pid = _provider(client)
    fake = FakeS3(
        buckets=["ok", "absent", "denied", "unsupported"],
        per_bucket={
            "denied": {method: _cerr("AccessDenied", 403)},
            "unsupported": {method: _cerr("NotImplemented", 501)},
        },
    )
    _use_fake(monkeypatch, fake)
    rid = _run_discovery(client, pid)
    return rid, client.get(f"/runs/{rid}/account-profile").json()


def test_encryption_tally_accounts_for_the_denied_bucket(client, monkeypatch, sync_runs):  # noqa: F811
    rid, prof = _mixed_survey(client, monkeypatch, "get_bucket_encryption")
    s = prof["summary"]
    assert s["encryption_undetermined"] == 1
    assert s["encryption_undetermined_buckets"] == ["denied"]
    assert s["encryption_unsupported"] == 1
    # The denied bucket is not silently folded into any established count.
    assert s["encryption_configured"] + s["encryption_not_configured"] == 2


@pytest.mark.parametrize("dimension", _DIMENSIONS)
def test_every_dimension_tally_adds_up_to_the_processed_count(
    client, monkeypatch, sync_runs, dimension  # noqa: F811
):
    """The invariant, not one hand-picked case: no dimension may leave buckets
    out of its own arithmetic, because a total that silently omits the unknowns
    is what makes a partial count read as a whole-account verdict."""
    rid, prof = _mixed_survey(client, monkeypatch, "get_bucket_encryption")
    s = prof["summary"]
    total = (s[f"{dimension}_configured"] + s[f"{dimension}_not_configured"]
             + s[f"{dimension}_unsupported"] + s[f"{dimension}_undetermined"])
    assert total == prof["processed_count"], f"{dimension} tally leaves buckets unaccounted for"


def test_report_names_the_buckets_whose_encryption_was_never_read(client, monkeypatch, sync_runs):  # noqa: F811
    from app import config

    rid, _ = _mixed_survey(client, monkeypatch, "get_bucket_encryption")
    rp = client.get(f"/runs/{rid}").json()["report_path"]
    text = (config.data_dir() / rp).read_text()
    assert "Encryption undetermined (denied / errored) | 1 (denied)" in text
    # and the other dimensions carry the row too, so the table always reconciles
    for dim in ("Public access block", "Logging", "Inventory", "Lifecycle"):
        assert f"{dim} undetermined (denied / errored)" in text
