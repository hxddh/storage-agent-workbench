"""v1.17.0 — Codex window: work language in the prompt and empty fallback."""

from pathlib import Path

from app.agent_runtime import finalize, prompt


def test_empty_work_result_is_work_language():
    assert "Ask again" not in finalize._EMPTY_ANSWER_FALLBACK
    assert "Work Result" in finalize._EMPTY_ANSWER_FALLBACK
    assert "Direction" in finalize._EMPTY_ANSWER_FALLBACK


def test_prompt_frames_a_direction_not_a_question():
    src = Path(prompt.__file__).read_text(encoding="utf-8")
    assert 'f"Direction:\\n{msg}"' in src
    assert "User question:" not in src
    assert "the user's Direction LIVE" in prompt.INSTRUCTIONS


def test_finalize_prompt_does_not_coach_tools_or_plans():
    assert "update_plan" not in prompt.FINALIZE_INSTRUCTIONS
    assert "before each tool call" not in prompt.FINALIZE_INSTRUCTIONS
    assert "No further tools are available" in prompt.FINALIZE_INSTRUCTIONS
    assert "update_plan" in prompt.INSTRUCTIONS
