"""Agent autonomy policy — how much the in-chat Agent does on its own.

The security invariants (no secrets to the model, no free shell/SQL, no
destructive or bucket-wide S3 operations, no object bodies in context) are
enforced *below* this layer and never change with the policy. The policy only
decides, for the actions that are already safe-by-construction, whether the
Agent executes them itself or proposes them for the user to run.

Two policies (default ``autonomous_readonly``):

- ``autonomous_readonly`` (自主) — the Agent EXECUTES read-only runs itself
  (bucket_config_review, account_discovery) and folds the findings into its
  answer. Connectivity/credential/addressing *diagnosis* is not a canned run
  here: the agent investigates adaptively with its own read-only tools.
- ``assisted`` (协助) — the Agent PROPOSES those runs for the user to confirm,
  and does not execute them on its own.

Either way, EXPENSIVE/data-moving work (dataset analysis, evidence
import/download, large scans) and any MUTATING op are never auto-run — they
always require explicit confirmation — and there is no write/destructive tool in
the product at all.

Risk tiers (independent of policy):

- ``SAFE_READONLY``  — read-only runs + the sanitized session report.
- ``EXPENSIVE``      — large scans / evidence download / dataset analysis.
- ``MUTATING``       — any write (not implemented; listed so tiering is total).
"""

from __future__ import annotations

ASSISTED = "assisted"
AUTONOMOUS_READONLY = "autonomous_readonly"
# Legacy value (pre-0.19.18 had a third "advisory" tier); maps to ``assisted``.
_LEGACY_ADVISORY = "advisory"

POLICIES = (ASSISTED, AUTONOMOUS_READONLY)
DEFAULT_POLICY = AUTONOMOUS_READONLY

# Risk tiers.
SAFE_READONLY = "safe_readonly"
EXPENSIVE = "expensive"
MUTATING = "mutating"

# The action types the Agent may EXECUTE inline (vs. only propose), by tier.
# Keep in lockstep with sessions.next_actions.ALLOWED_ACTION_TYPES.
ACTION_RISK = {
    "run_diagnostic": SAFE_READONLY,
    "run_bucket_config_review": SAFE_READONLY,
    "run_account_discovery": SAFE_READONLY,
    "generate_session_report": SAFE_READONLY,
    # Expensive / data-moving — always proposed, never auto-run.
    "run_inventory_analysis": EXPENSIVE,
    "run_access_log_analysis": EXPENSIVE,
    "plan_inventory_import": EXPENSIVE,
    "plan_access_log_import": EXPENSIVE,
    # Pure conversational — neither a run nor a write.
    "ask_user_for_context": SAFE_READONLY,
}

# The action types that actually have an inline executor tool
# (session_action_tools.build). Must stay in sync with that module. This is a
# *subset* of the SAFE_READONLY actions for two reasons:
#  - generate_session_report is SAFE_READONLY but has no inline tool (propose-only);
#  - run_diagnostic is intentionally NOT here: connectivity/credential/addressing
#    diagnosis is the agent's own ADAPTIVE job using its read-only session tools
#    (test_credentials → branch to test_addressing_style / inspect_endpoint_tls /
#    head_bucket / list_objects / test_range_get → reason → explain the root
#    cause), NOT a canned deterministic test_credentials→head_bucket→list pipeline.
#    The deterministic `diagnostic` run still exists as an explicit, auditable
#    report (proposable), but the agent doesn't reflexively fire it.
# Account discovery (bulk structured enumeration + persisted profile) and config
# review (the structured multi-reader snapshot) remain inline structured runs.
INLINE_EXECUTABLE = frozenset(
    {"run_bucket_config_review", "run_account_discovery"}
)


def normalize(policy: str | None) -> str:
    """Coerce an arbitrary value to a known policy (default ``autonomous_readonly``).

    The retired ``advisory`` value maps to ``assisted`` (propose-only).
    """
    p = (policy or "").strip().lower()
    if p == _LEGACY_ADVISORY:
        return ASSISTED
    return p if p in POLICIES else DEFAULT_POLICY


def executes_inline(policy: str) -> bool:
    """Whether SAFE_READONLY actions execute themselves under this policy.

    Only ``autonomous_readonly`` auto-executes; ``assisted`` proposes.
    """
    return normalize(policy) == AUTONOMOUS_READONLY


def may_execute(policy: str, action_type: str) -> bool:
    """Whether the Agent may EXECUTE ``action_type`` itself under ``policy``.

    True only when the policy auto-executes AND the action both is SAFE_READONLY
    and has a real inline executor tool. (A SAFE_READONLY action without an inline
    tool — e.g. ``generate_session_report`` — can only be proposed, so this
    returns False, matching the tools actually built.)
    """
    if not executes_inline(policy):
        return False
    return action_type in INLINE_EXECUTABLE and ACTION_RISK.get(action_type) == SAFE_READONLY


__all__ = [
    "ASSISTED", "AUTONOMOUS_READONLY", "POLICIES", "DEFAULT_POLICY",
    "SAFE_READONLY", "EXPENSIVE", "MUTATING", "ACTION_RISK", "INLINE_EXECUTABLE",
    "normalize", "executes_inline", "may_execute",
]
