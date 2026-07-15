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

# Default completion budget for a single agent turn (generous so long
# enumerations aren't truncated; the provider still bounds the actual length).
_DEFAULT_MAX_TOKENS = 8192


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
    settings_kwargs: dict[str, Any] = {"parallel_tool_calls": parallel_tool_calls}
    if max_tokens:
        settings_kwargs["max_tokens"] = max_tokens
    return Agent(name=name, instructions=instructions, tools=tools or [], model=model,
                 model_settings=ModelSettings(**settings_kwargs))


# --- model credentials (secret stays local to the LLM client) ----------------


def get_model_credentials(conn: sqlite3.Connection) -> dict[str, Any]:
    """Resolve the ACTIVE model provider + its API key from the vault.

    Selection: the explicitly activated provider (POST /model-providers/{id}/
    activate) wins; with no selection — or a stale selection pointing at a
    deleted provider — the oldest configured provider is the default (the
    pre-existing behavior, so single-provider installs are unchanged).

    The API key is a SECRET: it is used only to configure the LLM client and is
    never placed in the context, SSE events, reports, or logs.
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
    if not api_key:
        raise AgentUnavailable("The model provider has no API key stored in the system keyring.")
    return {
        "api_key": api_key,
        "model": row["model"] or "gpt-4o-mini",
        "base_url": row["base_url"],
        "provider_type": row["provider_type"],
        # Optional operator-declared context window (tokens); None → inferred from
        # the model name by model_budget. NOT a secret.
        "context_window": row["context_window"],
    }

