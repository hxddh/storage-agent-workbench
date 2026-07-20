"""Provider bucket/prefix scoping enforcement.

A cloud provider row may carry ``allowed_buckets`` / ``allowed_prefixes``
restrictions. This module is the single place that turns those lists into an
allow/deny decision for the deterministic surfaces (the two surviving
``/tools`` HTTP endpoints and the run executors). Empty/None lists mean
unrestricted.

All surfaces that address a bucket route through this one check: the agent's
session tools (``agent_runtime/session_tools.py``), the surviving ``/tools``
endpoints, and the run executors — so ``allowed_buckets`` AND ``allowed_prefixes``
are enforced identically everywhere (the agent previously enforced only buckets,
which let a prefix-scoped provider read outside its prefix via preview_object).
"""

from __future__ import annotations


def _prefix_in_scope(target: str, allowed_prefixes: list[str]) -> bool:
    """True if ``target`` is within one of ``allowed_prefixes`` at a PATH boundary.

    A plain ``startswith`` let ``allowed_prefixes=["logs"]`` admit
    ``logs-private/secret`` — a different top-level path. A prefix ``p`` matches
    only an EXACT equal, or ``p`` treated as a directory boundary (``p`` ending in
    ``/``, or ``target`` continuing with ``/`` right after ``p``). So ``logs``
    admits ``logs`` and ``logs/...`` but NOT ``logs-private/...``; ``logs/`` admits
    ``logs/...``. Callers already strip empty entries."""
    for p in allowed_prefixes:
        if target == p:
            return True
        boundary = p if p.endswith("/") else p + "/"
        if target.startswith(boundary):
            return True
    return False


def check_scope(
    allowed_buckets: list[str] | None,
    allowed_prefixes: list[str] | None,
    bucket: str,
    *,
    key: str | None = None,
    prefix: str | None = None,
    listing: bool = False,
) -> str | None:
    """Return None when the operation is in scope, else a short denial message.

    Rules:
    - ``allowed_buckets`` non-empty: ``bucket`` must be one of them.
    - ``allowed_prefixes`` non-empty: an explicit object ``key`` or listing
      ``prefix`` must start with one of them. A bucket-level operation (no
      key/prefix, e.g. head_bucket or config reads — ``listing=False``) is
      allowed: prefix scoping constrains object addressing, not bucket metadata.
      But a LISTING (``listing=True``) with no/empty prefix would enumerate the
      whole bucket root, OUTSIDE the allowed prefixes, so it is denied — the
      caller must list within an allowed prefix.
    """
    if allowed_buckets and bucket not in allowed_buckets:
        # List the allowed bucket names (they are non-secret DNS-style
        # identifiers), like the prefix branch below, so the caller can pick a
        # valid one instead of only learning a count. Bounded to keep it short.
        shown = ", ".join(allowed_buckets[:10])
        more = "" if len(allowed_buckets) <= 10 else f", …(+{len(allowed_buckets) - 10} more)"
        return (
            f"Bucket '{bucket}' is outside this provider's allowed_buckets scope. "
            f"Allowed: {shown}{more}."
        )
    # An empty-string entry would make every startswith() match — i.e. silently
    # unrestrict the bucket. Drop empties, so a stray "" doesn't widen scope.
    allowed_prefixes = [p for p in (allowed_prefixes or []) if p]
    if allowed_prefixes:
        target = key if key is not None else prefix
        if target:
            if not _prefix_in_scope(target, allowed_prefixes):
                kind = "key" if key is not None else "prefix"
                return (
                    f"The {kind} '{target}' is outside this provider's "
                    f"allowed_prefixes scope."
                )
        elif listing:
            # No/empty prefix on a listing → would enumerate the bucket root,
            # bypassing the prefix restriction. Require an in-scope prefix.
            return (
                "Listing the bucket root is outside this provider's "
                "allowed_prefixes scope; list within an allowed prefix "
                f"({', '.join(allowed_prefixes)})."
            )
    return None
