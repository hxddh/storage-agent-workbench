"""Model backends (v5): Responses first, Chat Completions for everything else.

``responses`` (official OpenAI endpoint):
- the websocket transport: one warm connection for every step of a turn
  (HTTP when the endpoint or a proxy refuses it — remembered per endpoint);
- deferred tool namespaces behind hosted tool search (the model loads a group
  of tools only when it needs it);
- server-side compaction inside a long turn (``context_management``);
- ``store=False`` — nothing is retained provider-side; encrypted reasoning is
  carried between steps of a turn only;
- reasoning effort for known-reasoning models.

``chat`` (every OpenAI-compatible endpoint): all tools sent, usage requested
best-effort, parallel tool calls unless the endpoint proved it mishandles them;
Ollama is asked for the planned window (``options.num_ctx``).

``max_tokens`` and the window come from ``budget.plan`` — the one place both
are decided.

A per-turn client is created and closed by the runner — no SDK globals, so
concurrent tasks never race on a shared default client.
"""

from __future__ import annotations

from typing import Any

from . import budget

TEMPERATURE = 0.2
MODEL_CALL_TIMEOUT_S = 600.0

# Endpoint capability refusals remembered for the process (keyed base_url|model):
# a strict endpoint that rejects an optional parameter is asked without it.
NO_PARALLEL: set[str] = set()
NO_USAGE: set[str] = set()
# Endpoints whose Responses websocket transport failed: they get HTTP instead.
NO_WEBSOCKET: set[str] = set()


def endpoint_key(creds: dict[str, Any]) -> str:
    return f"{creds.get('base_url') or 'openai'}|{creds.get('model') or ''}"


def forget_refusals(creds: dict[str, Any]) -> None:
    key = endpoint_key(creds)
    NO_PARALLEL.discard(key)
    NO_USAGE.discard(key)
    NO_WEBSOCKET.discard(key)


def is_responses(creds: dict[str, Any]) -> bool:
    return creds.get("api_style") == "responses"


def build(creds: dict[str, Any], clients: list[Any], *, tools_allowed: bool = True) -> tuple[Any, Any]:
    """(model, ModelSettings) for one turn. The client is registered in
    ``clients`` so the runner closes it when the turn ends."""
    import openai
    from agents import ModelSettings, OpenAIChatCompletionsModel, OpenAIResponsesModel
    from agents.retry import ModelRetrySettings

    client_kwargs: dict[str, Any] = {"api_key": creds["api_key"]}
    if creds.get("base_url"):
        client_kwargs["base_url"] = creds["base_url"]
    client = openai.AsyncOpenAI(**client_kwargs)
    clients.append(client)
    key = endpoint_key(creds)
    plan = budget.plan(creds)
    settings: dict[str, Any] = {
        "max_tokens": plan.max_tokens,
        "timeout": MODEL_CALL_TIMEOUT_S,
        # Runner-managed retries for transient provider failures (SDK retry).
        "retry": ModelRetrySettings(max_retries=2),
    }
    if not budget.is_reasoning_model(creds.get("model")):
        settings["temperature"] = TEMPERATURE  # reasoning models reject a sampling temperature
    if tools_allowed:
        settings["parallel_tool_calls"] = key not in NO_PARALLEL
    if creds.get("reasoning_effort"):
        from openai.types.shared import Reasoning
        settings["reasoning"] = Reasoning(effort=creds["reasoning_effort"])
    if is_responses(creds):
        if tools_allowed and key not in NO_WEBSOCKET:
            # One warm websocket per turn: every step of the loop reuses it.
            from agents.models.openai_responses import OpenAIResponsesWSModel
            model = OpenAIResponsesWSModel(model=creds["model"], openai_client=client)
            clients.append(model)
        else:
            model = OpenAIResponsesModel(model=creds["model"], openai_client=client)
        settings["store"] = False
        if budget.is_reasoning_model(creds.get("model")):
            settings["response_include"] = ["reasoning.encrypted_content"]
        settings["context_management"] = [{"type": "compaction", "compact_threshold": int(plan.window * 0.8)}]
    else:
        model = OpenAIChatCompletionsModel(model=creds["model"], openai_client=client)
        if key not in NO_USAGE:
            settings["include_usage"] = True
        if creds.get("kind") == "ollama":
            # Ollama loads a model with its own default context (often 2–4k) and
            # silently drops the oldest input beyond it: ask for the planned window.
            settings["extra_body"] = {"options": {"num_ctx": plan.window}}
    return model, ModelSettings(**settings)


async def close_clients(clients: list[Any]) -> None:
    for c in clients:
        try:
            await c.close()
        except Exception:  # noqa: BLE001
            pass
    clients.clear()
