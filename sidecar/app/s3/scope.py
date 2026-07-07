"""Provider bucket/prefix scoping enforcement.

A cloud provider row may carry ``allowed_buckets`` / ``allowed_prefixes``
restrictions. This module is the single place that turns those lists into an
allow/deny decision for the deterministic surfaces (the two surviving
``/tools`` HTTP endpoints and the run executors). Empty/None lists mean
unrestricted.

Note: the conversational session agent's tools enforce ``allowed_buckets``
separately (see ``agent_runtime/session_tools.py``); this module covers the
non-agent paths so scoping is not merely decorative outside the agent.
"""

from __future__ import annotations


def check_scope(
    allowed_buckets: list[str] | None,
    allowed_prefixes: list[str] | None,
    bucket: str,
    *,
    key: str | None = None,
    prefix: str | None = None,
) -> str | None:
    """Return None when the operation is in scope, else a short denial message.

    Rules:
    - ``allowed_buckets`` non-empty: ``bucket`` must be one of them.
    - ``allowed_prefixes`` non-empty: an explicit object ``key`` or listing
      ``prefix`` must start with one of them. A bucket-level operation (no
      key/prefix, e.g. head_bucket or config reads) is allowed — prefix scoping
      constrains object addressing, not bucket metadata.
    """
    if allowed_buckets and bucket not in allowed_buckets:
        return (
            f"Bucket '{bucket}' is outside this provider's allowed_buckets scope "
            f"({len(allowed_buckets)} bucket(s) allowed)."
        )
    if allowed_prefixes:
        target = key if key is not None else prefix
        if target and not any(target.startswith(p) for p in allowed_prefixes):
            kind = "key" if key is not None else "prefix"
            return (
                f"The {kind} '{target}' is outside this provider's "
                f"allowed_prefixes scope."
            )
    return None
