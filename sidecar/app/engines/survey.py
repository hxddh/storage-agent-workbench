"""The account survey engine (v5): read-only, bounded, honest about coverage.

test_credentials → list_buckets → (per bucket, at most ``HARD_MAX_BUCKETS``, in a
bounded pool) config snapshot + evidence-source discovery → a profile with a
summary that separates "configured", "not configured", "unsupported" and "we do
not know". Never lists objects, never downloads, never mutates.
"""

from __future__ import annotations

import fnmatch
import threading
import time
from collections import Counter
from collections.abc import Callable
from typing import Any

from .. import db
from ..s3 import account_tools, tools as s3tools
from ..s3.scope import check_scope
from ..security.redaction import redact_text

DEFAULT_MAX_BUCKETS = 100
HARD_MAX_BUCKETS = 500
PROBE_WORKERS = 4
_CONFIGURED = "available"
_NOT_CONFIGURED = "not_configured"
_UNSUPPORTED = "provider_unsupported"
_DENIED = "access_denied"

def _filter_buckets(names: list[str], include: str | None, exclude: str | None) -> list[str]:
    out = names
    if include:
        out = [n for n in out if fnmatch.fnmatch(n, include)]
    if exclude:
        out = [n for n in out if not fnmatch.fnmatch(n, exclude)]
    return out


def _count(buckets: list[dict[str, Any]], field: str, value: str) -> int:
    return sum(1 for b in buckets if b.get(field) == value)


def _undetermined(buckets: list[dict[str, Any]], field: str) -> list[str]:
    """Buckets whose status on this dimension was never established — the read
    was denied, errored, or the field was never written.

    ``provider_unsupported`` is counted separately (the provider genuinely has no
    such feature, which IS an answer); everything here is "we do not know". The
    per-dimension tallies used to report only configured/not_configured (+
    unsupported for some), so on an account where GetBucketEncryption is denied
    the numbers quietly failed to add up to the bucket count and "1 bucket has
    no default encryption" read as a verdict on all of them."""
    return [b["bucket_name"] for b in buckets
            if b.get(field) not in (_CONFIGURED, _NOT_CONFIGURED, _UNSUPPORTED)]


def _build_summary(buckets: list[dict[str, Any]], visible: int, processed: int, truncated: bool) -> dict[str, Any]:
    def names_where(pred) -> list[str]:
        return [b["bucket_name"] for b in buckets if pred(b)]

    with_inventory = names_where(
        lambda b: any(s.get("source_type") == "inventory" and s.get("status") == _CONFIGURED
                      for s in b.get("evidence_sources", []))
    )
    with_logging = names_where(
        lambda b: any(s.get("source_type") == "server_access_logging" and s.get("status") == _CONFIGURED
                      for s in b.get("evidence_sources", []))
    )
    # Public exposure is the survey's most critical fact — a policy-public or
    # ACL-public bucket makes the review list regardless of anything else.
    public_buckets = names_where(lambda b: b.get("publicly_exposed") is True
                                 or b.get("policy_is_public") is True)
    # …and the buckets where the question could not be ANSWERED. `account_tools`
    # already models this honestly: `publicly_exposed` is None when the policy
    # and ACL probes did not both yield a verdict. Collapsing that into the
    # "none detected" branch is how a minimal S3-compatible endpoint (MinIO,
    # Ceph, garage — the systems this product exists for, which answer 501 to
    # most config sub-resources) and an AWS credential without
    # `s3:GetBucketPolicyStatus` both got told their buckets are not public.
    exposure_unknown = names_where(
        lambda b: b.get("publicly_exposed") is None and b.get("policy_is_public") is not True
    )
    needs_review = names_where(
        lambda b: b.get("encryption_status") == _NOT_CONFIGURED
        or b.get("public_access_block_status") == _NOT_CONFIGURED
        or b.get("publicly_exposed") is True
        or b.get("policy_is_public") is True
    )
    access_denied = names_where(lambda b: b.get("access_status") == _DENIED)
    errored = names_where(lambda b: b.get("access_status") == "error")
    # Per dimension: configured + not_configured + unsupported + undetermined
    # must account for every processed bucket, so no tally can imply a verdict
    # over buckets whose read never landed. (`test_account_survey_tallies_*`
    # pins the arithmetic.)
    enc_unknown = _undetermined(buckets, "encryption_status")
    log_unknown = _undetermined(buckets, "logging_status")
    inv_unknown = _undetermined(buckets, "inventory_status")
    lc_unknown = _undetermined(buckets, "lifecycle_status")
    pab_unknown = _undetermined(buckets, "public_access_block_status")

    return {
        "public_buckets": public_buckets,
        "public_bucket_count": len(public_buckets),
        "exposure_unknown_buckets": exposure_unknown,
        "exposure_unknown_count": len(exposure_unknown),
        "acls_disabled_count": sum(1 for b in buckets if b.get("acls_disabled") is True),
        "visible_buckets": visible,
        "processed_buckets": processed,
        "truncated": truncated,
        "encryption_configured": _count(buckets, "encryption_status", _CONFIGURED),
        "encryption_not_configured": _count(buckets, "encryption_status", _NOT_CONFIGURED),
        "encryption_unsupported": _count(buckets, "encryption_status", _UNSUPPORTED),
        "encryption_undetermined": len(enc_unknown),
        "encryption_undetermined_buckets": enc_unknown,
        "logging_configured": _count(buckets, "logging_status", _CONFIGURED),
        "logging_not_configured": _count(buckets, "logging_status", _NOT_CONFIGURED),
        "logging_unsupported": _count(buckets, "logging_status", _UNSUPPORTED),
        "logging_undetermined": len(log_unknown),
        "inventory_configured": _count(buckets, "inventory_status", _CONFIGURED),
        "inventory_not_configured": _count(buckets, "inventory_status", _NOT_CONFIGURED),
        "inventory_unsupported": _count(buckets, "inventory_status", _UNSUPPORTED),
        "inventory_undetermined": len(inv_unknown),
        "lifecycle_configured": _count(buckets, "lifecycle_status", _CONFIGURED),
        "lifecycle_not_configured": _count(buckets, "lifecycle_status", _NOT_CONFIGURED),
        "lifecycle_unsupported": _count(buckets, "lifecycle_status", _UNSUPPORTED),
        "lifecycle_undetermined": len(lc_unknown),
        "public_access_block_configured": _count(buckets, "public_access_block_status", _CONFIGURED),
        "public_access_block_not_configured": _count(buckets, "public_access_block_status", _NOT_CONFIGURED),
        "public_access_block_unsupported": _count(buckets, "public_access_block_status", _UNSUPPORTED),
        "public_access_block_undetermined": len(pab_unknown),
        "buckets_with_inventory_evidence": with_inventory,
        "buckets_with_logging_evidence": with_logging,
        "buckets_needing_review": needs_review,
        "access_denied_buckets": access_denied,
        "error_buckets": errored,
    }


def exposure_note(summary: dict[str, Any]) -> str:
    """The survey's public-exposure sentence — THREE outcomes, not two.

    This is the highest-stakes thing the survey says. It is not a UI string: it
    lands in the run's ``final_summary``, the agent reads it, and the agent
    narrates it to the user as a security conclusion.

    It used to be binary — exposed, or "No publicly exposed buckets detected" —
    so a bucket whose policy/ACL probes never ANSWERED fell into the reassuring
    branch. That is the normal case for a minimal S3-compatible endpoint (MinIO,
    Ceph, garage answer 501 to most config sub-resources) and for a
    least-privilege AWS role without ``s3:GetBucketPolicyStatus``. Both were
    told their buckets are not public, on the strength of a check that never
    ran.

    "I checked and nothing is exposed" and "I could not check" are different
    facts, and only one of them is reassuring. Rule 18: a capability gap is
    reported, never silently resolved.
    """
    unknown_n = summary.get("exposure_unknown_count") or 0
    unknown_note = (
        f" Public exposure UNDETERMINED for {unknown_n} bucket(s)"
        f" ({', '.join(summary['exposure_unknown_buckets'][:5])}"
        f"{'…' if unknown_n > 5 else ''}) — the endpoint did not answer the"
        " policy/ACL checks (unsupported or denied), so this is not a clean bill of health."
        if unknown_n else ""
    )
    if summary.get("public_bucket_count"):
        # The severe fact leads, but a remaining gap is not swallowed by it:
        # fixing the named bucket must not look like fixing the account.
        return (
            f" PUBLIC EXPOSURE: {summary['public_bucket_count']} bucket(s) publicly exposed"
            f" ({', '.join(summary['public_buckets'][:5])}"
            f"{'…' if summary['public_bucket_count'] > 5 else ''})." + unknown_note
        )
    if unknown_n:
        return unknown_note
    return " No publicly exposed buckets detected."

# Scalar per-bucket aspects the diff compares (all already-sanitized status/enum/
# bool fields from the config snapshot + the bucket access status).
_DIFF_ASPECTS = (
    "access_status", "region", "head_bucket_status",
    "versioning_status", "versioning_enabled", "encryption_status",
    "lifecycle_status", "logging_status", "logging_enabled",
    # Public posture: the diff's most valuable alert — a bucket whose
    # policy_is_public/publicly_exposed flipped False→True BECAME PUBLIC.
    "policy_is_public", "policy_public_status", "object_ownership", "acls_disabled",
    "acl_public", "publicly_exposed",
    "replication_status", "policy_status", "public_access_block_status",
    "tagging_status", "inventory_status",
)
_MAX_DIFF_CHANGES = 200


def _scalar(v: Any) -> Any:
    """A short, safe representation of a scalar aspect value for the diff."""
    if v is None or isinstance(v, bool):
        return v
    return str(v)[:80]


def _evidence_map(bucket: dict[str, Any]) -> dict[str, Any]:
    return {e.get("source_type"): e.get("status")
            for e in (bucket.get("evidence_sources") or []) if e.get("source_type")}

def diff_profiles(old: dict[str, Any], new: dict[str, Any]) -> dict[str, Any]:
    """Deterministic diff of two account profiles (as returned by get_profile):
    buckets added/removed, per-bucket config-aspect changes, and evidence-source
    changes. Pure function — no LLM, no S3, no raw object listings; it reads only
    the already-persisted, already-sanitized profile facts. Bounded output.

    Membership changes are only trustworthy when BOTH surveys enumerated the
    whole account. A survey that stopped at its bucket cap did not observe the
    buckets past it, so "present then, absent now" can mean "deleted" or merely
    "not scanned this time" — and the second reading is the common one after a
    default-capped re-survey. Those entries are emitted with ``unverified`` set
    rather than dropped or silently asserted."""
    old_b = {b["bucket_name"]: b for b in (old.get("buckets") or [])}
    new_b = {b["bucket_name"]: b for b in (new.get("buckets") or [])}
    old_cut, new_cut = bool(old.get("truncated")), bool(new.get("truncated"))
    changes: list[dict[str, Any]] = []
    for name in sorted(set(new_b) - set(old_b)):
        entry: dict[str, Any] = {"bucket": name, "change": "bucket_added"}
        if old_cut:
            entry["unverified"] = True
            entry["note"] = ("the older survey was truncated — this bucket may have "
                             "existed then and simply not been scanned")
        changes.append(entry)
    for name in sorted(set(old_b) - set(new_b)):
        entry = {"bucket": name, "change": "bucket_removed"}
        if new_cut:
            entry["unverified"] = True
            entry["note"] = ("the newer survey was truncated — this bucket may still "
                             "exist and simply not have been scanned")
        changes.append(entry)
    baselined: set[str] = set()
    for name in sorted(set(old_b) & set(new_b)):
        ob, nb = old_b[name], new_b[name]
        for k in _DIFF_ASPECTS:
            if k in ob or k in nb:
                # An aspect the OLD survey never recorded (schema grew, e.g. the
                # v0.29 public-posture flags) is a BASELINE, not a change — on a
                # 60+ bucket account the None→value noise alone blew past the
                # change cap and could truncate a real "became public". Report
                # it once as a baselined field; the NEXT diff catches real flips.
                if k not in ob:
                    baselined.add(k)
                    continue
                ov, nv = ob.get(k), nb.get(k)
                if ov != nv:
                    entry: dict[str, Any] = {"bucket": name, "change": k,
                                             "from": _scalar(ov), "to": _scalar(nv)}
                    # Make security-relevant flips unmissable for the narrator.
                    if k in ("policy_is_public", "publicly_exposed", "acl_public") and nv is True:
                        entry["alert"] = True
                        entry["note"] = "bucket BECAME PUBLIC since the last survey"
                    changes.append(entry)
        oe, ne = _evidence_map(ob), _evidence_map(nb)
        for st in sorted(set(oe) | set(ne)):
            if oe.get(st) != ne.get(st):
                changes.append({"bucket": name, "change": f"evidence:{st}",
                                "from": _scalar(oe.get(st)), "to": _scalar(ne.get(st))})
    # Alerts first, so truncation can never cut a became-public signal.
    changes.sort(key=lambda c: not c.get("alert", False))
    out: dict[str, Any] = {
        "changes": changes[:_MAX_DIFF_CHANGES],
        "change_count": len(changes),
        # NOTE: this flag is about THIS LIST being capped at _MAX_DIFF_CHANGES.
        # It says nothing about how much of the account each survey saw — that
        # is surveys_truncated below. Two different subjects; do not conflate
        # them, and never read `truncated: false` as "full account coverage".
        "truncated": len(changes) > _MAX_DIFF_CHANGES,
        "changes_truncated": len(changes) > _MAX_DIFF_CHANGES,
        "surveys_truncated": {"older": old_cut, "newer": new_cut},
    }
    if old_cut or new_cut:
        which = " and ".join(w for w, c in (("older", old_cut), ("newer", new_cut)) if c)
        out["coverage_note"] = (
            f"The {which} survey stopped at its bucket cap, so this comparison did not "
            "see the whole account. Bucket added/removed entries marked unverified may "
            "be scan-coverage artifacts, not real additions or deletions, and a change "
            "on an unscanned bucket would not appear here at all. Do not report this as "
            "a complete account diff; re-survey with a higher max_buckets to settle it."
        )
    if baselined:
        out["fields_baselined"] = sorted(baselined)
        out["note"] = ("Some posture fields exist only in the newer survey (app upgrade); "
                       "they were baselined, not reported as changes. The next survey diff "
                       "will track them normally.")
    return out


# --- the survey --------------------------------------------------------------------

ProgressFn = Callable[[int, int, str], None]


def _probe(provider_id: str, names: list[str], progress: ProgressFn | None,
           cancelled: Callable[[], bool] | None) -> dict[str, dict[str, Any]]:
    """Every bucket's read-only probes in a bounded pool. Each worker uses its
    own connection only to read the provider row; nothing is written here."""
    from concurrent.futures import ThreadPoolExecutor

    done = [0]
    lock = threading.Lock()

    def one(name: str) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if cancelled and cancelled():
            out["skipped"] = True
            return out
        conn = db.connect()
        try:
            try:
                snap = account_tools.get_bucket_config_snapshot(conn, provider_id, name)
                raw = snap.pop("_raw_reads", None)
                out["snapshot"] = snap
            except Exception as exc:  # noqa: BLE001 — per-bucket isolation
                out["error"] = redact_text(str(exc))[:200]
                raw = None
            try:
                out["evidence"] = account_tools.discover_evidence_sources(conn, provider_id, name, pre_reads=raw)
            except Exception:  # noqa: BLE001
                out["evidence"] = {"sources": []}
        finally:
            conn.close()
            with lock:
                done[0] += 1
                n = done[0]
            if progress:
                progress(n, len(names), "buckets")
        return out

    if progress:
        progress(0, len(names), "buckets")
    if len(names) <= 1:
        return {n: one(n) for n in names}
    with ThreadPoolExecutor(max_workers=min(PROBE_WORKERS, len(names))) as pool:
        return dict(zip(names, pool.map(one, names)))


def run(conn: Any, provider_id: str, *, max_buckets: int = DEFAULT_MAX_BUCKETS, include: str | None = None,
        exclude: str | None = None, allowed_buckets: list[str] | None = None,
        allowed_prefixes: list[str] | None = None, progress: ProgressFn | None = None,
        cancelled: Callable[[], bool] | None = None) -> dict[str, Any]:
    """Survey one account. Returns the profile (never raises for a bucket)."""
    max_buckets = max(1, min(int(max_buckets or DEFAULT_MAX_BUCKETS), HARD_MAX_BUCKETS))
    cred = s3tools.test_credentials(conn, provider_id)
    lb = s3tools.list_buckets(conn, provider_id)
    list_status = lb.get("status", "error")
    names = [b["name"] for b in lb.get("buckets", []) or []]
    if list_status != _CONFIGURED:
        return {"success": False, "provider_id": provider_id, "list_status": list_status,
                "credentials_ok": bool(cred.get("success")),
                "error_code": lb.get("error_code") or list_status,
                "error_message_sanitized": redact_text(lb.get("error_message_sanitized") or "")[:300],
                "summary_text": f"ListBuckets {list_status}: the account could not be enumerated."}
    filtered = _filter_buckets(names, include, exclude)
    scoped = bool(allowed_buckets or allowed_prefixes)
    if scoped:
        filtered = [n for n in filtered if check_scope(allowed_buckets, allowed_prefixes, n) is None]
    truncated = len(filtered) > max_buckets
    selected = filtered[:max_buckets]
    probes = _probe(provider_id, selected, progress, cancelled)
    buckets: list[dict[str, Any]] = []
    stopped = False
    for name in selected:
        probe = probes.get(name) or {}
        if probe.get("skipped"):
            stopped = True
            continue
        snap = probe.get("snapshot")
        if snap is None:
            buckets.append({"bucket_name": name, "access_status": "error", "region": None,
                            "error": probe.get("error"), "evidence_sources": []})
            continue
        head = snap.get("head_bucket_status")
        access = {_DENIED: _DENIED, account_tools.REGION_MISMATCH: account_tools.REGION_MISMATCH,
                  "error": "error"}.get(head, _CONFIGURED)
        buckets.append({**{k: v for k, v in snap.items() if k not in ("success", "bucket")},
                        "bucket_name": name, "access_status": access,
                        "evidence_sources": (probe.get("evidence") or {}).get("sources", []) or []})
    summary = _build_summary(buckets, len(names), len(buckets), truncated or stopped)
    counts = dict(Counter(b["access_status"] for b in buckets))
    text = (f"{len(names)} bucket(s) visible, {len(buckets)} surveyed"
            f"{' (truncated at ' + str(max_buckets) + ')' if truncated else ''}"
            f"{' (stopped early)' if stopped else ''}. Access: "
            + (", ".join(f"{n} {s}" for s, n in counts.items()) or "none") + "." + exposure_note(summary))
    return {"success": True, "provider_id": provider_id, "list_status": list_status,
            "visible": len(names), "processed": len(buckets), "truncated": truncated or stopped,
            "whole_account": not (truncated or stopped or scoped or include or exclude),
            "summary": summary, "summary_text": text, "buckets": buckets}


# --- posture queries over a stored profile ---------------------------------------------

PROFILE_FLAGS = ("region", "access_status", "versioning_status", "encryption_status", "lifecycle_status",
                 "logging_status", "replication_status", "policy_status", "public_access_block_status",
                 "inventory_status", "policy_is_public", "object_ownership", "acls_disabled", "acl_public",
                 "publicly_exposed")
FILTERS = ("all", "public_buckets", "missing_encryption", "missing_public_access_block", "missing_lifecycle",
           "missing_logging", "no_versioning", "access_denied")
_DIMENSION = {"missing_public_access_block": "public_access_block_status", "missing_encryption": "encryption_status",
              "missing_lifecycle": "lifecycle_status", "missing_logging": "logging_status",
              "no_versioning": "versioning_status"}


def query(profile: dict[str, Any], filter_: str) -> dict[str, Any]:
    """Which surveyed buckets match a posture filter — and which could not be
    decided (unreadable or unsupported), reported as unknown, never as fine."""
    buckets = profile.get("buckets") or []

    def matches(b: dict[str, Any]) -> bool:
        if filter_ == "all":
            return True
        if filter_ == "public_buckets":
            return b.get("publicly_exposed") is True or b.get("policy_is_public") is True
        if filter_ == "access_denied":
            return b.get("access_status") == _DENIED
        return b.get(_DIMENSION[filter_]) == _NOT_CONFIGURED

    def unknown(b: dict[str, Any]) -> str | None:
        if filter_ in ("all", "access_denied"):
            return None
        if filter_ == "public_buckets":
            return None if b.get("publicly_exposed") is not None or b.get("policy_is_public") is True \
                else "exposure undetermined"
        st = b.get(_DIMENSION[filter_])
        return None if st in (_CONFIGURED, _NOT_CONFIGURED) else str(st or "unknown")

    rows = [{"bucket": b.get("bucket_name"), **{k: b.get(k) for k in PROFILE_FLAGS}} for b in buckets if matches(b)]
    undecided = [{"bucket": b.get("bucket_name"), "status": s} for b in buckets if not matches(b)
                 for s in (unknown(b),) if s]
    out: dict[str, Any] = {"success": True, "filter": filter_, "total_buckets": len(buckets),
                           "matched_count": len(rows), "buckets": rows[:200],
                           "survey_truncated": bool(profile.get("truncated")),
                           "undetermined_count": len(undecided)}
    if undecided:
        out["undetermined_buckets"] = undecided[:20]
        out["coverage_note"] = (f"{len(undecided)} bucket(s) could not be checked for '{filter_}' — their state "
                                "is unknown, not fine. Name them instead of implying a whole-account verdict.")
    return out
