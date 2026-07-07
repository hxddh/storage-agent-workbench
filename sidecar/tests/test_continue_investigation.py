"""1B: a turn cut short by the depth/context ceiling offers a one-click
'continue investigation' next-step, so a deep investigation resumes instead of
silently stopping. The proposal is a suggestion (user confirms by clicking),
deduped, and absent on a naturally-concluded turn.
"""
from app.agent_runtime import session_agent


def _has_continue(contract):
    return any(p.get("action_type") == "continue_investigation"
               for p in contract.get("next_action_proposals", []))


def test_continue_proposal_injected_on_cut_short():
    contract = session_agent._finalize_contract(
        "Partial findings so far…\n```json\n{\"next_action_proposals\": []}\n```",
        skill_names=[], activity=[])
    assert not _has_continue(contract)  # finalize contract alone has none
    out = session_agent._with_continue_proposal(contract)
    assert _has_continue(out)
    prop = out["next_action_proposals"][0]
    assert prop["action_type"] == "continue_investigation"
    assert prop["requires_confirmation"] is True  # a proposal, never automation


def test_continue_proposal_not_duplicated():
    contract = {"next_action_proposals": [
        {"action_type": "continue_investigation", "title": "x",
         "requires_confirmation": True}]}
    out = session_agent._with_continue_proposal(contract)
    n = sum(1 for p in out["next_action_proposals"]
            if p["action_type"] == "continue_investigation")
    assert n == 1  # not doubled


def test_continue_proposal_prepended_before_agent_proposals():
    contract = {"next_action_proposals": [
        {"action_type": "run_diagnostic", "title": "diag", "requires_confirmation": True}]}
    out = session_agent._with_continue_proposal(contract)
    assert out["next_action_proposals"][0]["action_type"] == "continue_investigation"
    assert out["next_action_proposals"][1]["action_type"] == "run_diagnostic"
