"""v0.62.0 — the offline triage learned what the config path already knew.

Offline triage is what runs when NO model provider is configured: an operator
with a pasted error and no agent to ask. It is the most degraded state the
product supports, and the one where a wrong answer costs most.

`s3/config_tools._NOT_CONFIGURED_CODES` already encodes exactly which S3 codes
mean "there is no such configuration on this bucket" — the config-reading path
uses it to report `not_configured` rather than an error. Measured before this
release, the triage playbooks knew **none of the twelve**, so every one landed in
`unknown`: a benign fact ("this bucket has no lifecycle rule") presented as an
unidentified fault, while the product's own neighbouring path had the right
answer all along.

Ten further codes an operator actually pastes had no playbook either. Several
are write-path codes; this product performs no writes, but offline triage exists
for errors hit ANYWHERE — aws-cli, rclone, the user's own application — so
refusing to explain them would answer a question nobody asked.
"""
from __future__ import annotations

import pytest

from app.error_triage import playbooks as pb
from app.s3 import config_tools as ct


# --- A: the not-configured family -------------------------------------------

@pytest.mark.parametrize("code", sorted(ct._NOT_CONFIGURED_CODES))
def test_every_not_configured_code_has_a_playbook(code: str):
    """Sourced from the config path's own set, so the two cannot drift apart.
    Adding a code there without one here is the failure this catches."""
    assert code in pb._BY_CODE, f"{code} means 'not configured' but triage has no entry"


@pytest.mark.parametrize("code", sorted(ct._NOT_CONFIGURED_CODES))
def test_a_not_configured_code_is_never_reported_as_unknown(code: str):
    hits = pb.match({"error_code": code})
    assert hits, f"{code} produced no playbook at all"
    assert all(h["category"] != "unknown" for h in hits), (
        f"{code} still falls through to 'unknown'")


@pytest.mark.parametrize("code", sorted(ct._NOT_CONFIGURED_CODES))
def test_it_says_plainly_that_nothing_is_broken(code: str):
    """The entire value of this family. An operator reading it must come away
    knowing the bucket is fine, not that something failed."""
    entry = pb._BY_CODE[code]
    assert entry["category"] == "not_configured"
    text = " ".join(entry["likely_causes"]).lower()
    assert "simply has no" in text or "nothing to return" in text
    assert entry["title"].lower().startswith("no ")


def test_the_not_configured_category_maps_to_a_real_skill():
    """A category with no skill silently falls back to generic triage, which is
    what this release exists to stop."""
    from app.skills import context as skill_context

    skill = pb.skill_for_category("not_configured")
    assert skill != "storageops-triage"
    assert skill in skill_context.skill_names(), f"{skill} is not a real skill"


def test_these_are_not_confused_with_a_genuine_capability_gap():
    """`not_configured` and `provider_unsupported` are different facts: one says
    the bucket has no such setting, the other says the endpoint has no such API.
    Conflating them would send the reader down the wrong path."""
    overlap = ct._NOT_CONFIGURED_CODES & ct._UNSUPPORTED_CODES
    assert overlap == set(), f"a code cannot mean both: {overlap}"


# --- B: real errors that had no playbook ------------------------------------

NEWLY_COVERED = [
    "InvalidArgument",
    "XAmzContentSHA256Mismatch",
    "AuthorizationQueryParametersError",
    "IllegalLocationConstraintException",
    "EntityTooLarge",
    "MalformedXML",
    "OperationAborted",
    "BucketNotEmpty",
    "RequestHeaderSectionTooLarge",
    "CrossLocationLoggingProhibited",
    "KMS.KMSInvalidStateException",
]


@pytest.mark.parametrize("code", NEWLY_COVERED)
def test_the_code_now_has_a_playbook(code: str):
    hits = pb.match({"error_code": code})
    assert hits, f"{code} produced no playbook"
    assert all(h["category"] != "unknown" for h in hits)


@pytest.mark.parametrize("code", NEWLY_COVERED)
def test_each_new_playbook_is_actionable(code: str):
    """A triage entry that names no cause and suggests no check is a label, not
    an answer."""
    e = pb._BY_CODE[code]
    assert e["likely_causes"], f"{code} lists no causes"
    assert e["next_checks"], f"{code} suggests no next check"
    assert e["confidence"] in ("high", "medium", "low")


@pytest.mark.parametrize("code", NEWLY_COVERED)
def test_no_new_playbook_suggests_a_mutating_action(code: str):
    """Rules never emit a mutating command — the module says so, and this is the
    half of the release most likely to break it, since several of these codes
    come FROM write operations."""
    allowed = {"run_diagnostic", "run_bucket_config_review", "plan_access_log_import",
               "ask_user_for_context", "generate_session_report"}
    for p in pb._BY_CODE[code]["proposals"]:
        assert p["action_type"] in allowed, f"{code} proposes {p['action_type']}"


@pytest.mark.parametrize("code", NEWLY_COVERED)
def test_every_named_next_check_is_a_real_tool_or_prose(code: str):
    """A check naming a tool that does not exist sends the reader looking for
    something the product cannot do."""
    import re

    from app.agent_runtime import session_agent as sa

    real = set(sa._GROUP_OF_TOOL) | set(sa._CORE_TOOLS)
    for check in pb._BY_CODE[code]["next_checks"]:
        # Entries are prose that may NAME a tool; only validate the identifiers.
        for token in re.findall(r"\b([a-z_]{6,})\(", check):
            assert token in real, f"{code}: next_check names unknown tool {token!r}"


def test_the_delete_advice_does_not_imply_this_product_deletes():
    """`BucketNotEmpty` is the one entry where a reader could infer the product
    will clear the bucket for them. It must say the opposite."""
    e = pb._BY_CODE["BucketNotEmpty"]
    caveats = " ".join(e["provider_caveats"]).lower()
    assert "no deletion" in caveats or "performs no deletions" in caveats


# --- the whole table ---------------------------------------------------------

def test_coverage_grew_and_nothing_was_displaced():
    """The additions are additive: every previously-known code still resolves."""
    for code in ("AccessDenied", "NoSuchBucket", "SignatureDoesNotMatch",
                 "SlowDown", "ExpiredToken", "NotImplemented"):
        hits = pb.match({"error_code": code})
        assert hits and all(h["category"] != "unknown" for h in hits), code
    assert len(pb._BY_CODE) >= 50


def test_every_entry_carries_the_fields_the_ui_renders():
    required = {"code", "category", "title", "confidence", "likely_causes",
                "evidence_to_check", "next_checks", "related_run_types",
                "provider_caveats", "proposals"}
    for code, entry in pb._BY_CODE.items():
        missing = required - set(entry)
        assert not missing, f"{code} is missing {missing}"
