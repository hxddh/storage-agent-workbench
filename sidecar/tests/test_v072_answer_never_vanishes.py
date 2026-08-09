"""v0.72.0 — the answer streamed, then the turn persisted nothing.

Reported from the shipped app: *"结果有流式输出，但是最后内容都会消失"* — the answer
streams in, and when the turn settles it is gone.

The mechanism is an asymmetry between two sources of the same answer. The live
stream is built from `raw_acc`, the accumulated text deltas. The PERSISTED
answer is built from `result.final_output`, a different object, with no guard:

    final_text = getattr(result, "final_output", "") or ""

The client keeps its streamed bubble only until the thread reloads the turn from
the server — at which point the persisted message replaces it. So an empty
`final_output` does not fail loudly; it silently replaces text the user watched
arrive with nothing at all.

The cancel path already gets this right: it rebuilds the answer from `raw_acc`,
sanitized. The success path — the overwhelmingly common one — did not.

Four realistic inputs persisted an empty answer, measured before the fix:

| input                                          | persisted |
| ---------------------------------------------- | --------- |
| `final_output` empty (no aggregate from server) | empty     |
| `final_output` is None                          | empty     |
| the answer wrapped entirely in `<think>`         | empty     |
| the answer is only the contract JSON block       | empty     |

The first two are provider behaviour this app does not control: an
OpenAI-compatible server that streams `delta.content` but returns an empty
aggregate message is a real shape, and it is exactly the shape a scripted test
double never produces — which is why every existing test passed while the
shipped app lost answers.
"""
from __future__ import annotations

import pytest

from app.agent_runtime import session_agent as sa


def _answer(raw, streamed: str = "") -> str:
    """What the turn would PERSIST for this final_output + streamed text.

    Goes through `_finalize_contract`, the real production path, rather than the
    helper alone — an earlier draft called the helper directly and so could not
    see that a model answering only with the contract block puts its reply in
    the block's `answer` field, which any pre-parse emptiness check destroys.
    """
    return sa._finalize_contract(raw, [], [], streamed=streamed).get("answer") or ""


STREAMED = "acme-logs denies every list call because the bucket policy omits s3:ListBucket."


@pytest.mark.parametrize("final_output,label", [
    ("", "an empty aggregate from the provider"),
    (None, "no aggregate at all"),
    ("   \n  ", "whitespace only"),
])
def test_the_streamed_answer_survives_a_provider_that_returns_no_aggregate(final_output, label):
    """The user watched this text arrive. It must still be there afterwards."""
    out = _answer(final_output, STREAMED)
    assert out.strip(), f"{label}: the answer vanished"
    assert "s3:ListBucket" in out, out


def test_a_real_final_output_is_preferred_over_the_stream():
    """The fallback is a SAFETY NET, not a replacement. When the provider gives a
    real aggregate that is what gets persisted — it is the authoritative text,
    and on the recovery paths it deliberately differs from what streamed."""
    out = _answer("The finalized answer.", STREAMED)
    assert out.strip() == "The finalized answer."


def test_an_answer_hidden_entirely_inside_think_tags_is_not_silently_dropped():
    """A reasoning model that wraps its whole reply in `<think>` leaves nothing
    after chain-of-thought stripping. Dropping it silently is the same failure
    the user reported; the turn has to say something instead of nothing."""
    out = _answer("<think>The policy omits s3:ListBucket, so list returns 403.</think>", "")
    assert out.strip(), "the turn persisted nothing at all"
    # …and it must NOT be the chain of thought itself (rule: no CoT in output).
    assert "<think>" not in out
    assert "s3:ListBucket" not in out


def test_an_unclosed_think_tag_never_reaches_the_answer():
    """A stream cut mid-thought leaves an UNCLOSED `<think>`, which used to be
    persisted verbatim — chain-of-thought shown to the user, which this product
    forbids outright."""
    out = _answer("<think>Let me check the policy and then explain it to the user", "")
    assert "<think>" not in out, out
    assert "Let me check the policy" not in out, out


def test_an_answer_that_is_only_the_contract_block_does_not_persist_as_blank():
    """The bookkeeping block is correctly held back from the answer. When it is
    ALL the model produced, the turn still owes the user a visible result rather
    than an empty bubble."""
    out = _answer('```json\n{"skills_used": [], "evidence_used": []}\n```', "")
    assert out.strip()
    assert "skills_used" not in out, out


def test_nothing_streamed_and_nothing_finalized_still_says_something():
    """The floor: a turn that produced no text at all must not render as an
    empty message. Silence is indistinguishable from a broken app."""
    out = _answer("", "")
    assert out.strip()


def test_the_fallback_is_sanitized_like_every_other_answer():
    """The streamed text has NOT been through the persist-time sanitizer, so the
    fallback must apply it rather than trusting raw model output."""
    leaked = (
        "Use AKIAIOSFODNN7EXAMPLE with secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY "
        "against acme-logs."
    )
    out = _answer("", leaked)
    assert "AKIAIOSFODNN7EXAMPLE" not in out, out
    assert "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" not in out, out
    assert "acme-logs" in out, "sanitizing must not destroy the diagnosis"


def test_the_fallback_drops_the_bookkeeping_block_too():
    """Falling back to the stream must not leak the contract JSON the normal
    path holds back."""
    out = _answer("", 'The policy omits s3:ListBucket.\n\n```json\n{"skills_used": []}\n```')
    assert "s3:ListBucket" in out
    assert "skills_used" not in out, out
