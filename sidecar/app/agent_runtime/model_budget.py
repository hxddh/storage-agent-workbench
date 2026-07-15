"""Model-elastic budgets.

The per-turn tool-output budget is the PRIMARY governor of how deep an
investigation goes — but it was a single hardcoded constant (200k chars ≈ 50k
tokens) chosen for "a modern 200k-token context". That throttles a 1M-context
model to a quarter of the depth its window supports, and doesn't shrink for a
small-context model. This module derives the budget from the active model's
context window instead, with the previous hardcoded values as a HARD FLOOR — so
no existing deployment ever regresses, and larger models get proportionally
deeper turns.

Security note: this only scales how much *tool output* (already sanitized,
bounded, no raw rows/bodies) the model may consume in one turn, and its
completion size. It does NOT touch any security-floor bound (preview/range byte
caps, list caps, sample caps, ingest caps) — those stay fixed.
"""

from __future__ import annotations

# Context windows in TOKENS, keyed on lowercased model-name SUBSTRINGS. Order
# matters — most-specific substrings first (the first containing match wins).
# Conservative where a family's members vary. An unknown model falls to
# _DEFAULT_CONTEXT, which yields exactly the historical floor.
_CONTEXT_WINDOWS: tuple[tuple[str, int], ...] = (
    ("gpt-4.1", 1_000_000), ("gpt-4o", 128_000), ("gpt-4-turbo", 128_000),
    ("gpt-4", 128_000), ("gpt-3.5", 16_385),
    ("o1", 200_000), ("o3", 200_000), ("o4", 200_000),
    ("claude-3-5", 200_000), ("claude-3-7", 200_000),
    ("claude-sonnet-4", 200_000), ("claude-opus-4", 200_000),
    ("claude-haiku-4", 200_000), ("claude", 200_000),
    ("deepseek-reasoner", 128_000), ("deepseek", 128_000),
    ("gemini-1.5", 1_000_000), ("gemini-2", 1_000_000), ("gemini", 1_000_000),
    ("qwen2.5", 128_000), ("qwen-max", 32_768), ("qwen", 32_768),
    ("llama-3", 128_000), ("llama", 128_000),
    ("mixtral", 32_768), ("mistral", 32_768),
)
_DEFAULT_CONTEXT = 128_000  # unknown model → yields exactly the current floor

# Fraction of the window we let tool output consume, and chars/token.
_TOOL_OUTPUT_FRACTION = 0.25
_CHARS_PER_TOKEN = 4

# Floors == the historical hardcoded values. Budgets NEVER go below these, so an
# existing 128k/200k deployment is byte-for-byte unchanged.
TOOL_OUTPUT_CHARS_FLOOR = 200_000       # was session_agent._MAX_TOOL_OUTPUT_CHARS
COMPLETION_TOKENS_FLOOR = 16_384        # was session_agent._MAX_COMPLETION_TOKENS
COMPLETION_TOKENS_CEILING = 32_768      # stay under provider max-output caps


def context_window(model: str | None) -> int:
    """The active model's approximate input context window in tokens."""
    m = (model or "").lower()
    for sub, win in _CONTEXT_WINDOWS:
        if sub in m:
            return win
    return _DEFAULT_CONTEXT


def tool_output_char_budget(model: str | None) -> int:
    """Per-turn tool-output character budget, scaled to the model's window but
    never below the historical floor. 128k/200k models → 200_000 (unchanged);
    1M models → 1_000_000."""
    tokens = int(context_window(model) * _TOOL_OUTPUT_FRACTION)
    return max(TOOL_OUTPUT_CHARS_FLOOR, tokens * _CHARS_PER_TOKEN)


def completion_token_budget(model: str | None) -> int:
    """Completion (max_tokens) budget: raised only where the window clearly
    supports it, floored at the historical value and capped under known
    provider max-output limits so we never trigger a 400."""
    return max(COMPLETION_TOKENS_FLOOR, min(context_window(model) // 8, COMPLETION_TOKENS_CEILING))
