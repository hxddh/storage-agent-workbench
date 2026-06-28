"""Agent autonomy policy — how much the in-chat agent may do on its own.

The security invariants (no secrets to the model, no free shell/SQL, no
destructive or bucket-wide S3 operations, no object bodies in context) are
enforced *below* this layer and never change with the policy. The policy only
decides, for the actions that are already safe-by-construction, whether the
agent executes them itself or merely proposes them for the user to run.

Risk tiers (independent of policy):

- ``SAFE_READONLY``  — read-only runs (diagnostic, bucket_config_review,
  account_discovery) and the sanitized session report. They touch no object
  bodies, mutate nothing, and are already what a manual run would do.
- ``EXPENSIVE``      — large scans / evidence download / dataset analysis. These
  move data or cost real time/money; they always require explicit confirmation
  with a preview, regardless of policy.
- ``MUTATING``       — any write. Not implemented in this product (no write tool
  exists); listed so the tiering is total.

Policies:

- ``advisory``            — the agent executes nothing; it only proposes (the
  pre-autonomy behavior).
- ``assisted`` (default)  — the agent executes SAFE_READONLY actions inline;
  EXPENSIVE/MUTATING stay proposals.
- ``autonomous_readonly`` — same execution surface as ``assisted`` today (all
  safe read-only work, including multi-run orchestration, runs without a
  per-action prompt); EXPENSIVE/MUTATING still require confirmation.

``assisted`` and ``autonomous_readonly`` share the same *capability* surface
(only SAFE_READONLY auto-executes); they differ in UX intent — ``assisted``
surfaces each executed step as confirmable activity, ``autonomous_readonly``
lets the agent chain them freely. Both keep EXPENSIVE/MUTATING gated.
"""

from __future__ import annotations

ADVISORY = "advisory"
ASSISTED = "assisted"
AUTONOMOUS_READONLY = "autonomous_readonly"

POLICIES = (ADVISORY, ASSISTED, AUTONOMOUS_READONLY)
DEFAULT_POLICY = ASSISTED

# Risk tiers.
SAFE_READONLY = "safe_readonly"
EXPENSIVE = "expensive"
MUTATING = "mutating"

# The action types the agent may EXECUTE inline (vs. only propose), by tier.
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


def normalize(policy: str | None) -> str:
    """Coerce an arbitrary value to a known policy (default ``assisted``)."""
    p = (policy or "").strip().lower()
    return p if p in POLICIES else DEFAULT_POLICY


def executes_inline(policy: str) -> bool:
    """Whether SAFE_READONLY actions execute themselves under this policy."""
    return normalize(policy) in (ASSISTED, AUTONOMOUS_READONLY)


def may_execute(policy: str, action_type: str) -> bool:
    """Whether the agent may EXECUTE ``action_type`` itself under ``policy``.

    Only SAFE_READONLY actions are ever auto-executed, and only when the policy
    allows inline execution. Everything else is proposed for confirmation.
    """
    if not executes_inline(policy):
        return False
    return ACTION_RISK.get(action_type) == SAFE_READONLY


__all__ = [
    "ADVISORY", "ASSISTED", "AUTONOMOUS_READONLY", "POLICIES", "DEFAULT_POLICY",
    "SAFE_READONLY", "EXPENSIVE", "MUTATING", "ACTION_RISK",
    "normalize", "executes_inline", "may_execute",
]
