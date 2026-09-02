"""Model client + credentials for the conversational agent.

This module is intentionally small: it builds an Agents-SDK Agent with a per-run
model client (`build_agent`) and resolves the configured provider's API key
(`get_model_credentials`). There is no second "run planner" agent — the
conversational session agent (`session_agent.py`) is the only LLM in the product;
``runs/`` are pure deterministic compute it invokes or saves as artifacts.
"""

from __future__ import annotations

import sqlite3
from typing import Any

from ..security import keyring_store
from .model_budget import is_reasoning_model

# Default completion budget for a single agent turn (generous so long
# enumerations aren't truncated; the provider still bounds the actual length).
_DEFAULT_MAX_TOKENS = 8192

# Sampling temperature for the investigator (v0.56.0). See build_agent for why
# this is set at all, and why it is low rather than zero.
AGENT_TEMPERATURE = 0.2


class AgentUnavailable(Exception):
    """Agent mode cannot run (no model/key, unsupported type, SDK missing).

    The message is safe to surface to the user.
    """


def build_agent(
    creds: dict[str, Any],
    tools: list[Any] | None = None,
    instructions: str = "",
    *,
    name: str = "Storage Agent",
    max_tokens: int | None = _DEFAULT_MAX_TOKENS,
    parallel_tool_calls: bool = False,
    client_registry: list[Any] | None = None,
    include_usage: bool = True,
    prompt_cache_retention: str | None = None,
    temperature: float | None = None,
    model_timeout: float | None = None,
    reasoning_effort: str | None = None,
) -> Any:
    """Build an Agents-SDK Agent with a PER-RUN model client.

    The single place the conversational agent builds its model. The client is
    passed explicitly via
    ``OpenAIChatCompletionsModel`` instead of being set on the SDK's process-wide
    default (``set_default_openai_client``) — mutating that global per request
    races across concurrent sessions/runs. A per-run client keeps every run fully
    independent. Chat Completions is used for all providers (third-party
    OpenAI-compatible endpoints such as DeepSeek don't implement the Responses
    API the SDK otherwise defaults to). Raises AgentUnavailable if the SDK is
    missing so callers can fail cleanly / fall back.

    ``client_registry``: when given, the AsyncOpenAI client created here is
    appended so the caller can CLOSE it when the turn ends (per-turn clients
    hold open HTTP connection pools; without this they leak until GC).
    """
    try:
        import openai  # noqa: F401
        from agents import (Agent, ModelSettings, OpenAIChatCompletionsModel,
                            set_tracing_disabled)
    except Exception as exc:  # noqa: BLE001
        raise AgentUnavailable("OpenAI Agents SDK is not available in this environment.") from exc

    # Never upload traces/prompts (privacy; also avoids a spurious OpenAI auth
    # call that fails for third-party providers). Constant, not per-run.
    set_tracing_disabled(True)
    client_kwargs: dict[str, Any] = {"api_key": creds["api_key"]}
    if creds.get("base_url"):
        client_kwargs["base_url"] = creds["base_url"]
    client = openai.AsyncOpenAI(**client_kwargs)
    if client_registry is not None:
        client_registry.append(client)
    model = OpenAIChatCompletionsModel(model=creds.get("model") or "gpt-4o-mini",
                                       openai_client=client)
    # Ask for streamed token usage explicitly. The SDK only defaults this on for
    # the OFFICIAL OpenAI client (is_official_openai_client); against any custom
    # base_url — which is this app's main case — it omits stream_options entirely
    # and the stream reports no usage at all. Setting it here is what makes usage
    # observable for third-party OpenAI-compatible endpoints.
    #
    # It is a best-effort ask, not a requirement: a strict endpoint that rejects
    # the unknown parameter is retried without it (see session_agent's usage
    # fallback), because provider compatibility outranks a metrics field.
    settings_kwargs: dict[str, Any] = {"parallel_tool_calls": parallel_tool_calls}
    # Temperature was never set, so every endpoint applied its own default —
    # typically 1.0, and not the same across providers (v0.56.0). This agent
    # reports what storage endpoints actually returned; two runs of the same
    # investigation should not diverge because the sampler felt creative, and an
    # operator comparing today's answer to last week's is entitled to assume the
    # difference is the BUCKET, not the decoder.
    #
    # Not 0: a strict-greedy decode makes some models loop on a tool call that
    # keeps failing instead of trying another approach, and adaptive
    # investigation is the whole product. Low-but-not-zero keeps tool choice
    # stable while leaving room to change tack.
    if temperature is not None:
        settings_kwargs["temperature"] = temperature
    if include_usage:
        settings_kwargs["include_usage"] = True
    if max_tokens:
        settings_kwargs["max_tokens"] = max_tokens
    # Ask the endpoint to KEEP the prompt-cache entry between turns (v0.55.0).
    #
    # Measured on the real 42-tool agent: the fixed prefix — system prompt plus
    # tool schemas — is ~12,284 tokens and is re-sent on every step of every
    # turn; on a realistic 8-tool turn it is 57% of the whole input bill. It is a
    # byte-identical prefix, which is exactly what prompt caching exists for, and
    # nothing in this app had ever asked for it. Whether it lands is now
    # observable rather than assumed: v0.53.0 already records
    # `cached_input_tokens` per turn, so the footer shows the real hit rate.
    #
    # Best-effort, like `include_usage`: an endpoint that rejects the unknown
    # parameter is retried without it (`_NO_CACHE_RETENTION_ENDPOINTS` in
    # session_agent), because provider compatibility outranks a cost optimization.
    if prompt_cache_retention:
        settings_kwargs["prompt_cache_retention"] = prompt_cache_retention
    # Bound ONE model-call attempt (openai-agents 0.21.1). Every tool has had a
    # wall-clock ceiling since v0.56.0; the model call had none, which left the
    # slowest thing in a turn as the only unbounded one. The client's own read
    # timeout is 600 s and it retries twice, so a stalled endpoint could hold a
    # turn for half an hour while a tool doing the same work would have been cut
    # off at 120 s.
    #
    # Enforced by the SDK's run loop through asyncio cancellation, so it is
    # model-agnostic and applies to the chat-completions path this app uses. It
    # bounds the WHOLE attempt including the stream, not the gap between events —
    # which is why the value is generous rather than tight (see _MODEL_TIMEOUT_S).
    # It does not replace the client's retries: the ceiling is per attempt.
    if model_timeout:
        settings_kwargs["timeout"] = model_timeout
    # Reasoning effort (v1.10.0): forwarded as Chat Completions
    # ``reasoning_effort`` by the SDK. Only ever set for a provider whose model
    # is known-reasoning (``get_model_credentials`` drops it otherwise), so a
    # plain endpoint never sees an unknown parameter.
    if reasoning_effort:
        try:
            from openai.types.shared import Reasoning
            settings_kwargs["reasoning"] = Reasoning(effort=reasoning_effort)
        except Exception:  # noqa: BLE001 — an SDK without the type just skips it
            pass
    return Agent(name=name, instructions=instructions, tools=tools or [], model=model,
                 model_settings=ModelSettings(**settings_kwargs))


# --- model credentials (secret stays local to the LLM client) ----------------


# Provider types that run locally and do not require an API key.
# For these, an absent key is replaced with a dummy "not-needed" token
# so the OpenAI-compatible client can still be constructed (Ollama,
# LM Studio, vLLM, llama.cpp all accept any non-empty Bearer value or
# ignore it entirely). The secret still never enters model context.
LOCAL_PROVIDER_TYPES = frozenset({
    "ollama", "lmstudio", "lm_studio", "local", "openai-compatible",
    "openai_compatible", "vllm", "llamacpp", "llama_cpp", "localai", "local_ai",
})

# Default base URLs for local providers when none is configured.
LOCAL_DEFAULT_BASE_URLS: dict[str, str] = {
    "ollama": "http://127.0.0.1:11434/v1",
    "lmstudio": "http://127.0.0.1:1234/v1",
    "lm_studio": "http://127.0.0.1:1234/v1",
    "local": "http://127.0.0.1:11434/v1",
    "openai-compatible": "http://127.0.0.1:11434/v1",
    "openai_compatible": "http://127.0.0.1:11434/v1",
    "vllm": "http://127.0.0.1:8000/v1",
    "llamacpp": "http://127.0.0.1:8080/v1",
    "llama_cpp": "http://127.0.0.1:8080/v1",
}

def _is_local_provider(provider_type: str | None) -> bool:
    return (provider_type or "").strip().lower() in LOCAL_PROVIDER_TYPES


def get_model_credentials(conn: sqlite3.Connection) -> dict[str, Any]:
    """Resolve the ACTIVE model provider + its API key from the vault.

    Selection: the explicitly activated provider (POST /model-providers/{id}/
    activate) wins; with no selection — or a stale selection pointing at a
    deleted provider — the oldest configured provider is the default (the
    pre-existing behavior, so single-provider installs are unchanged).

    The API key is a SECRET: it is used only to configure the LLM client and is
    never placed in the context, SSE events, reports, or logs.

    Local providers (ollama, lmstudio, etc.) do not require a stored key:
    an absent key is replaced with a dummy value so the client can be built.
    """
    from ..repositories import model_providers as mp_repo

    # Single source of truth shared with the serialized `active` flag (explicit
    # selection, else oldest) — so the UI badge and the agent never disagree.
    row = None
    active_id = mp_repo.effective_active_id(conn)
    if active_id:
        row = conn.execute(
            "SELECT * FROM model_providers WHERE id = ?", (active_id,)
        ).fetchone()
    if row is None:
        raise AgentUnavailable("No model provider configured. Add one under Providers to use Agent mode.")
    api_key = None
    if row["api_key_ref"]:
        scope, name = keyring_store.parse_ref(row["api_key_ref"])
        api_key = keyring_store.get_secret(scope, name)
    provider_type = row["provider_type"]
    is_local = _is_local_provider(provider_type)
    # Local providers may run without a key (Ollama etc. ignore Bearer).
    if not api_key:
        if is_local:
            api_key = "not-needed"
        else:
            raise AgentUnavailable("The model provider has no API key stored in the system keyring.")
    # Resolve base_url: explicit wins, else local default, else None (→ OpenAI default).
    base_url = row["base_url"]
    if not base_url and is_local:
        base_url = LOCAL_DEFAULT_BASE_URLS.get((provider_type or "").strip().lower())
    return {
        "api_key": api_key,
        "model": row["model"] or ("llama3" if is_local else "gpt-4o-mini"),
        "base_url": base_url,
        "provider_type": provider_type,
        # Optional operator-declared context window (tokens); None → inferred from
        # the model name by model_budget. NOT a secret.
        "context_window": row["context_window"],
        # Optional operator-declared max output tokens; None → inferred. NOT a secret.
        "max_output_tokens": row["max_output_tokens"],
        # Reasoning effort (v1.10.0) — only for a known-reasoning model, so an
        # endpoint that does not accept the parameter never receives it.
        "reasoning_effort": (row["reasoning_effort"]
                             if is_reasoning_model(row["model"]) else None),
    }

