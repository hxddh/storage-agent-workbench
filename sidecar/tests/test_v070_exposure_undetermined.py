"""v0.70.0 — "no public buckets" was also what the app said when it never looked.

The account survey's public-exposure line is the highest-stakes sentence this
product emits. It is not a UI string: it goes into the survey's `final_summary`,
the agent reads it, and the agent narrates it to the user as a security
conclusion.

It had two branches — exposed, or "No publicly exposed buckets detected." There
was no branch for *could not determine*, so a bucket whose policy/ACL probes
never answered fell into the reassuring one.

`account_tools` already models this correctly: `publicly_exposed` is None when
the policy and ACL reads did not both yield a verdict. The collapse happened one
level up, in `_build_summary`/the summary text.

Measured in a browser (`e2e/survey.spec.ts`) against four endpoints. Three
produced the SAME sentence:

| endpoint                                        | probes    | verdict                  |
| ----------------------------------------------- | --------- | ------------------------ |
| minimal S3-compatible, 501 NotImplemented        | never ran | "No publicly exposed…"   |
| AWS creds without s3:GetBucketPolicyStatus, 403  | never ran | "No publicly exposed…"   |
| full AWS, genuinely private                      | ran       | "No publicly exposed…"   |
| full AWS, one public bucket                      | ran       | "PUBLIC EXPOSURE: 1…"    |

The first two are not corner cases. MinIO, Ceph and garage — the S3-compatible
systems this product exists to diagnose — answer 501 to most bucket-config
sub-resources, and a least-privilege AWS role routinely lacks
`s3:GetBucketPolicyStatus`. Rule 18 is exactly about this: a capability gap is
`Provider unsupported`, never a silent verdict.
"""
from __future__ import annotations

import pytest

from app.runs.account_discovery_run import _build_summary, exposure_note


def _bucket(name: str, *, exposed: bool | None, policy_public: bool | None = None) -> dict:
    return {
        "bucket_name": name,
        "access_status": "available",
        "publicly_exposed": exposed,
        "policy_is_public": policy_public,
        "evidence_sources": [],
    }


def _summary(buckets: list[dict]) -> dict:
    return _build_summary(buckets, visible=len(buckets), processed=len(buckets), truncated=False)


# --- the count itself --------------------------------------------------------


def test_a_bucket_whose_exposure_is_unknown_is_counted_as_unknown():
    s = _summary([_bucket("acme-logs", exposed=None)])
    assert s["exposure_unknown_count"] == 1, s
    assert s["exposure_unknown_buckets"] == ["acme-logs"]
    # …and NOT as public. Unknown is not an accusation either.
    assert s["public_bucket_count"] == 0


def test_a_bucket_checked_and_found_private_is_not_unknown():
    s = _summary([_bucket("acme-logs", exposed=False, policy_public=False)])
    assert s["exposure_unknown_count"] == 0, s
    assert s["public_bucket_count"] == 0


def test_a_public_bucket_is_public_not_unknown():
    s = _summary([_bucket("acme-public", exposed=True, policy_public=True)])
    assert s["public_bucket_count"] == 1
    assert s["exposure_unknown_count"] == 0


def test_a_policy_public_bucket_counts_even_if_the_acl_read_failed():
    """`policy_is_public` True is already a verdict — the ACL adding nothing
    does not make the bucket's status unknown."""
    s = _summary([_bucket("acme-public", exposed=None, policy_public=True)])
    assert s["public_bucket_count"] == 1
    assert s["exposure_unknown_count"] == 0, s


def test_an_account_can_be_partly_known_and_partly_not():
    s = _summary([
        _bucket("known-private", exposed=False, policy_public=False),
        _bucket("known-public", exposed=True, policy_public=True),
        _bucket("unanswered", exposed=None),
    ])
    assert s["public_bucket_count"] == 1
    assert s["exposure_unknown_count"] == 1
    assert s["exposure_unknown_buckets"] == ["unanswered"]


# --- the sentence the agent actually reads -----------------------------------


def _summary_text(buckets: list[dict]) -> str:
    """The sentence the agent actually reads.

    Calls the PRODUCTION function. An earlier version of this file rebuilt the
    branch logic here, which would have passed happily against a copy while the
    app kept saying the wrong thing.
    """
    from collections import Counter

    counts = dict(Counter(b["access_status"] for b in buckets))
    return ("Access status: " + ", ".join(f"{n} {k}" for k, n in counts.items())
            + "." + exposure_note(_summary(buckets)))


@pytest.mark.parametrize("buckets,must_contain,must_not_contain", [
    # Never checked → must not read as a clean bill of health.
    ([_bucket("a", exposed=None)], "UNDETERMINED", "No publicly exposed buckets detected"),
    # Checked and clean → the reassuring sentence is EARNED here.
    ([_bucket("a", exposed=False, policy_public=False)],
     "No publicly exposed buckets detected", "UNDETERMINED"),
    # Exposed → named.
    ([_bucket("a", exposed=True, policy_public=True)], "PUBLIC EXPOSURE", "UNDETERMINED"),
])
def test_the_three_outcomes_read_differently(buckets, must_contain, must_not_contain):
    text = _summary_text(buckets)
    assert must_contain in text, text
    assert must_not_contain not in text, text


def test_a_public_bucket_and_an_unanswered_one_are_both_reported():
    """The severe fact leads, but the gap is not swallowed by it — otherwise
    fixing the named bucket would look like fixing the account."""
    text = _summary_text([
        _bucket("acme-public", exposed=True, policy_public=True),
        _bucket("unanswered", exposed=None),
    ])
    assert "PUBLIC EXPOSURE" in text
    assert "UNDETERMINED" in text, text
    assert "unanswered" in text


def test_the_undetermined_sentence_names_the_buckets_and_the_reason():
    """A count alone is not actionable: the operator has to know WHICH buckets
    to check by hand, and why the app could not."""
    text = _summary_text([_bucket("acme-logs", exposed=None),
                          _bucket("acme-backups", exposed=None)])
    assert "acme-logs" in text and "acme-backups" in text
    assert "unsupported or denied" in text
    assert "not a clean bill of health" in text
