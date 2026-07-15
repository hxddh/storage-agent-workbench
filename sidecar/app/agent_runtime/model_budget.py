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

# Per-model MAX OUTPUT (completion) tokens, keyed on lowercased substrings, most
# specific first. Several providers cap output well below what window//8 implies —
# passing max_tokens above the cap is a hard 400. The completion budget is clamped
# to this so we never over-request. Unknown model → _DEFAULT_MAX_OUTPUT.
_MAX_OUTPUT_TOKENS: tuple[tuple[str, int], ...] = (
    ("gpt-4-turbo", 4_096), ("gpt-4o", 16_384), ("gpt-4.1", 32_768), ("gpt-4", 8_192),
    ("gpt-3.5", 4_096),
    ("o1", 100_000), ("o3", 100_000), ("o4", 100_000),
    ("claude-3-5", 8_192), ("claude-3-7", 64_000),
    ("claude-sonnet-4", 64_000), ("claude-opus-4", 32_000), ("claude-haiku-4", 32_000),
    ("claude", 8_192),
    ("gemini-1.5", 8_192), ("gemini-2", 8_192), ("gemini", 8_192),
    ("deepseek", 8_192),
    ("qwen", 8_192), ("llama", 4_096), ("mixtral", 4_096), ("mistral", 4_096),
)
# Unknown model → the historical completion floor, so v0.27.0 behavior is
# preserved (no regression): only KNOWN small-output models are clamped down.
_DEFAULT_MAX_OUTPUT = 16_384

# Fraction of the window we let tool output consume, and chars/token.
_TOOL_OUTPUT_FRACTION = 0.25
_CHARS_PER_TOKEN = 4

# Floors == the historical hardcoded values. Budgets NEVER go below these, so an
# existing 128k/200k deployment is byte-for-byte unchanged.
TOOL_OUTPUT_CHARS_FLOOR = 200_000       # was session_agent._MAX_TOOL_OUTPUT_CHARS
COMPLETION_TOKENS_FLOOR = 16_384        # was session_agent._MAX_COMPLETION_TOKENS
COMPLETION_TOKENS_CEILING = 32_768      # stay under provider max-output caps


def context_window(model: str | None, explicit: int | None = None) -> int:
    """The active model's approximate input context window in tokens.

    ``explicit`` (an operator-declared window from the model-provider config) wins
    when positive — so a newly-shipped model absent from the substring table isn't
    throttled to the default. Otherwise the table decides; unknown → default.
    """
    if explicit and explicit > 0:
        return explicit
    m = (model or "").lower()
    for sub, win in _CONTEXT_WINDOWS:
        if sub in m:
            return win
    return _DEFAULT_CONTEXT


def max_output_tokens(model: str | None) -> int:
    """The active model's provider-imposed MAX output tokens (best-effort). Used to
    clamp the completion budget so we never send a max_tokens the provider rejects."""
    m = (model or "").lower()
    for sub, cap in _MAX_OUTPUT_TOKENS:
        if sub in m:
            return cap
    return _DEFAULT_MAX_OUTPUT


def tool_output_char_budget(model: str | None, explicit_window: int | None = None) -> int:
    """Per-turn tool-output character budget, scaled to the model's window but
    never below the historical floor. 128k/200k models → 200_000 (unchanged);
    1M models → 1_000_000."""
    tokens = int(context_window(model, explicit_window) * _TOOL_OUTPUT_FRACTION)
    return max(TOOL_OUTPUT_CHARS_FLOOR, tokens * _CHARS_PER_TOKEN)


def completion_token_budget(model: str | None, explicit_window: int | None = None) -> int:
    """Completion (max_tokens) budget: raised only where the window clearly
    supports it, floored at the historical value, capped by the module ceiling AND
    by the model's real provider max-output so we never trigger a 400.

    The provider cap is applied only when it's *below* the floor for a genuinely
    small-output model — the floor otherwise wins (an existing deployment is
    unchanged), but a 4k-output model like gpt-4-turbo is clamped down to 4096
    rather than being handed the 16384 floor it would reject."""
    scaled = max(COMPLETION_TOKENS_FLOOR,
                 min(context_window(model, explicit_window) // 8, COMPLETION_TOKENS_CEILING))
    return min(scaled, max_output_tokens(model))
