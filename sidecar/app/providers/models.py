"""Model endpoints (v5).

A model provider is an endpoint + model + key reference. `api_style` decides
how the Agent talks to it:

- ``responses`` — the OpenAI Responses API: hosted tool search over deferred
  tool namespaces, native tool calling, reasoning effort. The official OpenAI
  endpoint only.
- ``chat`` — Chat Completions: every OpenAI-compatible endpoint (DeepSeek,
  OpenRouter, Anthropic's compatibility endpoint, Ollama, LM Studio, vLLM,
  llama.cpp …). Everything works; the Responses-only features are off.

The API key lives in the vault; the frontend never receives it.
"""

from __future__ import annotations

import sqlite3
import uuid
from typing import Any, Literal

from pydantic import BaseModel, Field

from ..agent import budget
from ..repositories import has_value, utcnow
from ..security import keyring_store

KEYRING_SCOPE = "model_provider"

Kind = Literal["openai", "anthropic", "deepseek", "openrouter", "ollama", "lmstudio", "vllm",
               "llamacpp", "openai-compatible"]

LOCAL_KINDS = frozenset({"ollama", "lmstudio", "vllm", "llamacpp", "openai-compatible"})
DEFAULT_BASE_URLS: dict[str, str] = {
    "anthropic": "https://api.anthropic.com/v1/",
    "deepseek": "https://api.deepseek.com/v1",
    "openrouter": "https://openrouter.ai/api/v1",
    "ollama": "http://127.0.0.1:11434/v1",
    "lmstudio": "http://127.0.0.1:1234/v1",
    "vllm": "http://127.0.0.1:8000/v1",
    "llamacpp": "http://127.0.0.1:8080/v1",
    "openai-compatible": "http://127.0.0.1:11434/v1",
}
_OFFICIAL_OPENAI_HOSTS = ("api.openai.com",)


class AgentUnavailable(Exception):
    """No usable model (none configured, key missing). Safe to show the user."""


class ModelProviderIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    kind: Kind = "openai"
    base_url: str | None = None
    model: str = Field(min_length=1, max_length=200)
    api_key: str | None = None
    api_style: Literal["responses", "chat"] | None = None
    context_window: int | None = Field(default=None, ge=0)
    max_output_tokens: int | None = Field(default=None, ge=0)
    reasoning_effort: Literal["low", "medium", "high", ""] | None = None


class ModelProviderPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    kind: Kind | None = None
    base_url: str | None = None
    model: str | None = Field(default=None, min_length=1, max_length=200)
    api_key: str | None = None
    api_style: Literal["responses", "chat"] | None = None
    context_window: int | None = Field(default=None, ge=0)
    max_output_tokens: int | None = Field(default=None, ge=0)
    reasoning_effort: Literal["low", "medium", "high", ""] | None = None


def default_api_style(kind: str, base_url: str | None) -> str:
    """Responses only where the hosted features exist: the official endpoint."""
    if kind != "openai":
        return "chat"
    if not base_url:
        return "responses"
    return "responses" if any(h in base_url for h in _OFFICIAL_OPENAI_HOSTS) else "chat"


def _secret_name(provider_id: str) -> str:
    return f"{provider_id}/api_key"


def _out(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "kind": row["kind"],
        "base_url": row["base_url"],
        "model": row["model"],
        "api_style": row["api_style"],
        "has_api_key": keyring_store.secret_exists(row["api_key_ref"]),
        "context_window": row["context_window"],
        "max_output_tokens": row["max_output_tokens"],
        "reasoning_effort": row["reasoning_effort"] or None,
        "reasoning_capable": budget.is_reasoning_model(row["model"]),
        "active": bool(row["active"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def list_all(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    _normalize_active(conn)
    return [_out(r) for r in conn.execute(
        "SELECT * FROM model_providers ORDER BY created_at, rowid").fetchall()]


def get(conn: sqlite3.Connection, provider_id: str) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM model_providers WHERE id = ?", (provider_id,)).fetchone()
    return _out(row) if row else None


def _normalize_active(conn: sqlite3.Connection) -> None:
    """Exactly one active provider whenever any exists (the oldest by default)."""
    if conn.execute("SELECT 1 FROM model_providers WHERE active = 1").fetchone():
        return
    row = conn.execute("SELECT id FROM model_providers ORDER BY created_at, rowid LIMIT 1").fetchone()
    if row:
        conn.execute("UPDATE model_providers SET active = 1 WHERE id = ?", (row["id"],))
        conn.commit()


def create(conn: sqlite3.Connection, data: ModelProviderIn) -> dict[str, Any]:
    pid = uuid.uuid4().hex
    now = utcnow()
    ref = keyring_store.save_secret(KEYRING_SCOPE, _secret_name(pid), data.api_key) \
        if has_value(data.api_key) else None
    style = data.api_style or default_api_style(data.kind, data.base_url)
    conn.execute(
        "INSERT INTO model_providers (id, name, kind, base_url, model, api_key_ref, api_style, context_window, "
        "max_output_tokens, reasoning_effort, active, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
        (pid, data.name, data.kind, data.base_url or None, data.model, ref, style,
         data.context_window or None, data.max_output_tokens or None, data.reasoning_effort or None, now, now))
    conn.commit()
    _normalize_active(conn)
    return get(conn, pid)  # type: ignore[return-value]


def update(conn: sqlite3.Connection, provider_id: str, data: ModelProviderPatch) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM model_providers WHERE id = ?", (provider_id,)).fetchone()
    if row is None:
        return None
    fields = data.model_dump(exclude_unset=True)
    ref = row["api_key_ref"]
    if has_value(fields.pop("api_key", None) or ""):
        ref = keyring_store.save_secret(KEYRING_SCOPE, _secret_name(provider_id), data.api_key)  # type: ignore[arg-type]
    merged = {k: row[k] for k in ("name", "kind", "base_url", "model", "api_style", "context_window",
                                  "max_output_tokens", "reasoning_effort")}
    for key, value in fields.items():
        # "" / 0 clear a field; None keeps it.
        if value is None:
            continue
        merged[key] = None if value in ("", 0) else value
    if "api_style" not in fields and ("kind" in fields or "base_url" in fields):
        merged["api_style"] = default_api_style(merged["kind"], merged["base_url"])
    conn.execute(
        "UPDATE model_providers SET name=?, kind=?, base_url=?, model=?, api_key_ref=?, api_style=?, "
        "context_window=?, max_output_tokens=?, reasoning_effort=?, updated_at=? WHERE id=?",
        (merged["name"], merged["kind"], merged["base_url"], merged["model"], ref,
         merged["api_style"] or "chat", merged["context_window"], merged["max_output_tokens"],
         merged["reasoning_effort"], utcnow(), provider_id))
    conn.commit()
    return get(conn, provider_id)


def delete(conn: sqlite3.Connection, provider_id: str) -> bool:
    if conn.execute("SELECT 1 FROM model_providers WHERE id = ?", (provider_id,)).fetchone() is None:
        return False
    keyring_store.delete_secret(KEYRING_SCOPE, _secret_name(provider_id))
    conn.execute("DELETE FROM model_providers WHERE id = ?", (provider_id,))
    conn.commit()
    _normalize_active(conn)
    return True


def activate(conn: sqlite3.Connection, provider_id: str) -> bool:
    if conn.execute("SELECT 1 FROM model_providers WHERE id = ?", (provider_id,)).fetchone() is None:
        return False
    conn.execute("UPDATE model_providers SET active = CASE WHEN id = ? THEN 1 ELSE 0 END", (provider_id,))
    conn.commit()
    return True


def credentials(conn: sqlite3.Connection, provider_id: str | None = None) -> dict[str, Any]:
    """The active (or named) provider with its key resolved. The key is used
    only to build the model client — never placed in context, items or logs."""
    _normalize_active(conn)
    if provider_id:
        row = conn.execute("SELECT * FROM model_providers WHERE id = ?", (provider_id,)).fetchone()
    else:
        row = conn.execute("SELECT * FROM model_providers WHERE active = 1").fetchone()
    if row is None:
        raise AgentUnavailable("No model is configured. Add one in Settings › Models.")
    key = None
    if row["api_key_ref"]:
        scope, name = keyring_store.parse_ref(row["api_key_ref"])
        key = keyring_store.get_secret(scope, name)
    local = row["kind"] in LOCAL_KINDS
    if not key:
        if not local:
            raise AgentUnavailable("The active model has no API key. Add it in Settings › Models.")
        key = "not-needed"
    base_url = row["base_url"] or DEFAULT_BASE_URLS.get(row["kind"])
    return {
        "provider_id": row["id"],
        "kind": row["kind"],
        "api_key": key,
        "base_url": base_url,
        "model": row["model"],
        "api_style": row["api_style"],
        "context_window": budget.context_window(row["model"], row["context_window"]),
        "max_output_tokens": row["max_output_tokens"],
        "reasoning_effort": (row["reasoning_effort"] if budget.is_reasoning_model(row["model"]) else None),
    }
