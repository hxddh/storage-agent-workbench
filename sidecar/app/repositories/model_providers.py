"""Model provider repository."""

from __future__ import annotations

import sqlite3
import uuid

from .. import audit
from ..models.schemas import (
    ModelProviderCreate,
    ModelProviderOut,
    ModelProviderUpdate,
)
from ..security import keyring_store
from . import has_value, utcnow
from . import settings as settings_repo

KEYRING_SCOPE = "model_provider"
# app_settings key naming the provider the agent uses. Unset → the oldest
# configured provider (the pre-existing implicit behavior) stays the default.
ACTIVE_SETTING_KEY = "active_model_provider_id"


def _secret_name(provider_id: str) -> str:
    return f"{provider_id}/api_key"


def active_provider_id(conn: sqlite3.Connection) -> str | None:
    """The EXPLICITLY selected provider id, or None (→ oldest is the default)."""
    return settings_repo.get(conn, ACTIVE_SETTING_KEY)


def effective_active_id(conn: sqlite3.Connection) -> str | None:
    """The provider the agent ACTUALLY uses — the single source of truth shared
    by ``get_model_credentials`` and the serialized ``active`` flag.

    The explicit selection wins when it still points at a real provider;
    otherwise (fresh/single-provider install, or the selected one was deleted)
    the oldest provider is the implicit default. Keeping the UI flag and the
    agent's choice on the same rule avoids the "no badge but the agent is using
    one" mismatch.
    """
    explicit = active_provider_id(conn)
    if explicit and conn.execute(
        "SELECT 1 FROM model_providers WHERE id = ?", (explicit,)
    ).fetchone():
        return explicit
    row = conn.execute(
        "SELECT id FROM model_providers ORDER BY created_at, rowid LIMIT 1"
    ).fetchone()
    return row["id"] if row else None


def set_active(conn: sqlite3.Connection, provider_id: str) -> bool:
    """Mark one provider as the agent's active model. False if it doesn't exist."""
    row = conn.execute(
        "SELECT id FROM model_providers WHERE id = ?", (provider_id,)
    ).fetchone()
    if row is None:
        return False
    settings_repo.set(conn, ACTIVE_SETTING_KEY, provider_id)
    audit.record(conn, "model_provider.activate", {"id": provider_id})
    conn.commit()
    return True


def _row_to_out(row: sqlite3.Row, active_id: str | None = None) -> ModelProviderOut:
    return ModelProviderOut(
        id=row["id"],
        name=row["name"],
        provider_type=row["provider_type"],
        base_url=row["base_url"],
        model=row["model"],
        api_key_ref=row["api_key_ref"],
        has_api_key=keyring_store.secret_exists(row["api_key_ref"]),
        context_window=row["context_window"],
        active=(row["id"] == active_id),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def list_all(conn: sqlite3.Connection) -> list[ModelProviderOut]:
    active_id = effective_active_id(conn)
    rows = conn.execute(
        "SELECT * FROM model_providers ORDER BY created_at DESC, id"
    ).fetchall()
    return [_row_to_out(r, active_id) for r in rows]


def get(conn: sqlite3.Connection, provider_id: str) -> ModelProviderOut | None:
    row = conn.execute(
        "SELECT * FROM model_providers WHERE id = ?", (provider_id,)
    ).fetchone()
    return _row_to_out(row, effective_active_id(conn)) if row else None


def create(conn: sqlite3.Connection, data: ModelProviderCreate) -> ModelProviderOut:
    provider_id = uuid.uuid4().hex
    now = utcnow()

    api_key_ref: str | None = None
    if has_value(data.api_key):
        api_key_ref = keyring_store.save_secret(
            KEYRING_SCOPE, _secret_name(provider_id), data.api_key  # type: ignore[arg-type]
        )

    conn.execute(
        "INSERT INTO model_providers "
        "(id, name, provider_type, base_url, model, api_key_ref, context_window, "
        " created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            provider_id,
            data.name,
            data.provider_type,
            data.base_url,
            data.model,
            api_key_ref,
            data.context_window,
            now,
            now,
        ),
    )
    audit.record(
        conn,
        "model_provider.create",
        {"id": provider_id, "name": data.name, "provider_type": data.provider_type},
    )
    conn.commit()
    return get(conn, provider_id)  # type: ignore[return-value]


def update(
    conn: sqlite3.Connection, provider_id: str, data: ModelProviderUpdate
) -> ModelProviderOut | None:
    existing = conn.execute(
        "SELECT * FROM model_providers WHERE id = ?", (provider_id,)
    ).fetchone()
    if existing is None:
        return None

    name = data.name if data.name is not None else existing["name"]
    provider_type = (
        data.provider_type if data.provider_type is not None else existing["provider_type"]
    )
    base_url = data.base_url if data.base_url is not None else existing["base_url"]
    model = data.model if data.model is not None else existing["model"]
    context_window = (
        data.context_window if data.context_window is not None else existing["context_window"]
    )

    api_key_ref = existing["api_key_ref"]
    if has_value(data.api_key):
        api_key_ref = keyring_store.save_secret(
            KEYRING_SCOPE, _secret_name(provider_id), data.api_key  # type: ignore[arg-type]
        )

    conn.execute(
        "UPDATE model_providers SET name=?, provider_type=?, base_url=?, model=?, "
        "api_key_ref=?, context_window=?, updated_at=? WHERE id=?",
        (name, provider_type, base_url, model, api_key_ref, context_window,
         utcnow(), provider_id),
    )
    audit.record(
        conn,
        "model_provider.update",
        {"id": provider_id, "rotated_api_key": has_value(data.api_key)},
    )
    conn.commit()
    return get(conn, provider_id)


def delete(conn: sqlite3.Connection, provider_id: str) -> bool:
    row = conn.execute(
        "SELECT id FROM model_providers WHERE id = ?", (provider_id,)
    ).fetchone()
    if row is None:
        return False

    keyring_store.delete_secret(KEYRING_SCOPE, _secret_name(provider_id))
    conn.execute("DELETE FROM model_providers WHERE id = ?", (provider_id,))
    # Deleting the active provider clears the selection → the oldest remaining
    # provider becomes the implicit default again (never a dangling pointer).
    if active_provider_id(conn) == provider_id:
        conn.execute("DELETE FROM app_settings WHERE key = ?", (ACTIVE_SETTING_KEY,))
    audit.record(conn, "model_provider.delete", {"id": provider_id})
    conn.commit()
    return True
