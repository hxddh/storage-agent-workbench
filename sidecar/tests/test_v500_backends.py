"""Both model backends build from real SDK types, without a network call.

The fake endpoint speaks Chat Completions, so the Responses path (deferred tool
namespaces behind hosted tool search, server-side compaction, store=False) is
pinned here by construction: a regression in how it is assembled fails fast.
"""

from __future__ import annotations

import asyncio

from app.agent import models, prompt
from app.agent import tools as _tools  # noqa: F401
from app.agent.tools import registry


def _creds(style: str, model: str = "gpt-5") -> dict:
    return {"provider_id": "p", "kind": "openai", "api_key": "sk-test", "base_url": "https://api.openai.com/v1",
            "model": model, "api_style": style, "context_window": 400_000, "max_output_tokens": None,
            "reasoning_effort": "medium"}


def test_responses_backend_defers_tool_groups_behind_tool_search(conn):
    from agents import Agent, ToolSearchTool
    clients: list = []
    model, settings = models.build(_creds("responses"), clients)
    try:
        # One warm websocket for every step of a turn.
        assert type(model).__name__ == "OpenAIResponsesWSModel"
        assert model in clients  # closed with the turn
        assert settings.store is False
        assert settings.context_management == [{"type": "compaction", "compact_threshold": 320_000}]
        assert "reasoning.encrypted_content" in (settings.response_include or [])
        tools = registry.build_sdk_tools(responses=True)
        names = {getattr(t, "name", None) for t in tools}
        # Core tools stay loaded; every other group is a deferred namespace.
        assert {"record_conclusion", "query_estate", "list_buckets"} <= names
        assert not any(getattr(t, "defer_loading", False) for t in tools if getattr(t, "name", "") in
                       {"record_conclusion", "query_estate"})
        assert any(getattr(t, "defer_loading", False) for t in tools)
        agent = Agent(name="Storage Agent", instructions=prompt.instructions_for(conn, responses=True, lang="en"),
                      tools=[*tools, ToolSearchTool()], model=model, model_settings=settings)
        assert "loaded on demand" in agent.instructions
    finally:
        asyncio.run(models.close_clients(clients))


def test_chat_backend_sends_every_tool_and_asks_for_usage(conn):
    clients: list = []
    model, settings = models.build(_creds("chat", "deepseek-chat") | {"reasoning_effort": None}, clients)
    try:
        assert type(model).__name__ == "OpenAIChatCompletionsModel"
        assert settings.include_usage is True and settings.parallel_tool_calls is True
        tools = registry.build_sdk_tools(responses=False)
        assert len(tools) == len(registry.REGISTRY)
        assert not any(getattr(t, "defer_loading", False) for t in tools)
    finally:
        asyncio.run(models.close_clients(clients))


def test_a_refused_optional_parameter_is_not_sent_again(conn):
    creds = _creds("chat", "some-model") | {"reasoning_effort": None}
    models.NO_PARALLEL.add(models.endpoint_key(creds))
    models.NO_USAGE.add(models.endpoint_key(creds))
    clients: list = []
    _, settings = models.build(creds, clients)
    asyncio.run(models.close_clients(clients))
    assert settings.parallel_tool_calls is False and settings.include_usage is None
    models.forget_refusals(creds)
    assert models.endpoint_key(creds) not in models.NO_PARALLEL


def test_a_refused_websocket_falls_back_to_http(conn):
    creds = _creds("responses")
    models.NO_WEBSOCKET.add(models.endpoint_key(creds))
    clients: list = []
    model, _ = models.build(creds, clients)
    asyncio.run(models.close_clients(clients))
    assert type(model).__name__ == "OpenAIResponsesModel"
    models.forget_refusals(creds)
    assert models.endpoint_key(creds) not in models.NO_WEBSOCKET


def test_side_steps_never_open_a_websocket(conn):
    clients: list = []
    model, _ = models.build(_creds("responses"), clients, tools_allowed=False)
    asyncio.run(models.close_clients(clients))
    assert type(model).__name__ == "OpenAIResponsesModel"
