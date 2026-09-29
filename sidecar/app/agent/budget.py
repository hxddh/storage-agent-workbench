"""Model windows and the completion budget.

The context window decides when history is compacted, how much of one tool
output the model reads, and how many completion tokens a request may ask for.
An operator-declared window (Settings › Models) always wins; otherwise a
substring table of known model families decides (the longest matching entry);
a local endpoint without a declared window is assumed small
(``LOCAL_DEFAULT_WINDOW``: a local server's configured context is usually far
below what the model supports).

Security note: this scales only how much already-sanitized, bounded text the
model reads and writes. It does NOT touch any security-floor bound (preview /
range byte caps, list caps, sample caps, ingest caps) — those stay fixed.
"""

from __future__ import annotations

# Context windows in TOKENS, keyed on lowercased model-name substrings. The
# LONGEST matching substring wins, so a specific entry (codellama, qwen3,
# mistral-nemo) is never shadowed by its family (llama, qwen, mistral),
# whatever the order here. Conservative where a family's members vary.
_CONTEXT_WINDOWS: dict[str, int] = {
    # Hosted families.
    "gpt-4.1": 1_000_000, "gpt-4o": 128_000, "gpt-4-turbo": 128_000, "gpt-4": 128_000, "gpt-3.5": 16_385,
    "o1": 200_000, "o3": 200_000, "o4": 200_000,
    "claude": 200_000,
    "deepseek": 128_000,
    "gemini": 1_000_000,
    # Open families (also served locally by Ollama, LM Studio, vLLM, llama.cpp).
    "qwen": 32_768, "qwen2.5": 128_000, "qwen3": 32_768, "qwen-max": 32_768,
    "llama": 128_000, "llama3": 128_000, "llama-3": 128_000, "llama2": 4_096, "llama-2": 4_096,
    "codellama": 16_384,
    "mistral": 32_768, "mixtral": 32_768, "mistral-nemo": 128_000,
    "gemma": 8_192, "gemma2": 8_192, "gemma-2": 8_192, "gemma3": 128_000, "gemma-3": 128_000,
    "phi": 4_096, "phi-3": 128_000, "phi3": 128_000, "phi-4": 16_384, "phi4": 16_384,
}
_DEFAULT_CONTEXT = 128_000  # an unknown hosted model
LOCAL_DEFAULT_WINDOW = 16_384  # a local / self-hosted endpoint whose window was not declared

# Per-model MAX OUTPUT (completion) tokens, same longest-match rule. Several
# providers cap output well below what window//8 implies — passing max_tokens
# above the cap is a hard 400.
_MAX_OUTPUT_TOKENS: dict[str, int] = {
    "gpt-4-turbo": 4_096, "gpt-4o": 16_384, "gpt-4.1": 32_768, "gpt-4": 8_192, "gpt-3.5": 4_096,
    "o1": 100_000, "o3": 100_000, "o4": 100_000,
    "claude": 8_192, "claude-3-5": 8_192, "claude-3-7": 64_000,
    "claude-sonnet-4": 64_000, "claude-opus-4": 32_000, "claude-haiku-4": 32_000,
    "gemini": 8_192, "gemini-1.5": 8_192, "gemini-2": 8_192, "gemini-2.5": 64_000,
    "deepseek": 8_192, "deepseek-reasoner": 64_000,
    "qwen": 8_192, "llama": 4_096, "mixtral": 4_096, "mistral": 4_096,
}
_DEFAULT_MAX_OUTPUT = 16_384

COMPLETION_TOKENS_FLOOR = 16_384
# The floor is a compat guarantee for large windows, never a licence to exceed a
# small one: the completion budget is clamped to half the window (vLLM rejects
# max_tokens ≥ context), with a tiny minimum for a degenerate declared window.
_COMPLETION_TOKENS_MIN = 1_024


# Models known to accept a reasoning-effort knob on Chat Completions
# (``reasoning_effort``). Unknown → False: the Composer paints no effort control
# and the runtime sends nothing, the only safe default against an endpoint that
# would 400 on an unknown parameter.
_REASONING_MODELS: tuple[str, ...] = (
    "o1", "o3", "o4", "gpt-5", "gpt-oss", "deepseek-reasoner", "deepseek-r1",
    "-r1", "qwq", "qwen3", "thinking", "grok-3-mini", "grok-4", "glm-4.5", "glm-4.6",
    "kimi-k2", "magistral",
)


def _longest_match(model: str | None, table: dict[str, int]) -> int | None:
    m = (model or "").strip().lower()
    hits = [sub for sub in table if sub in m]
    return table[max(hits, key=len)] if hits else None


def is_reasoning_model(model: str | None) -> bool:
    """Whether ``model`` is known to accept ``reasoning_effort``."""
    m = (model or "").strip().lower()
    return bool(m) and any(sub in m for sub in _REASONING_MODELS)


def known_context_window(model: str | None) -> int | None:
    """The table's window for ``model``, or None when the model is not known."""
    return _longest_match(model, _CONTEXT_WINDOWS)


def context_window(model: str | None, explicit: int | None = None) -> int:
    """The model's input context window in tokens: the declared one when
    positive, else the table, else the default for an unknown hosted model."""
    if explicit and explicit > 0:
        return explicit
    return known_context_window(model) or _DEFAULT_CONTEXT


def max_output_tokens(model: str | None, explicit_max: int | None = None) -> int:
    """The model's provider-imposed max output tokens (best effort); a declared cap wins."""
    if explicit_max and explicit_max > 0:
        return explicit_max
    return _longest_match(model, _MAX_OUTPUT_TOKENS) or _DEFAULT_MAX_OUTPUT


def completion_token_budget(model: str | None, explicit_window: int | None = None,
                            explicit_max: int | None = None) -> int:
    """max_tokens for a request: window//8 floored at 16 384, never above half
    the window, and never above the model's real max output."""
    window = context_window(model, explicit_window)
    scaled = max(COMPLETION_TOKENS_FLOOR, window // 8)
    scaled = min(scaled, max(_COMPLETION_TOKENS_MIN, window // 2))
    return min(scaled, max_output_tokens(model, explicit_max))
