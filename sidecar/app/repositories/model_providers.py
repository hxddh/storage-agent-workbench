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

KEYRING_SCOPE = "model_provider"


def _secret_name(provider_id: str) -> str:
    return f"{provider_id}/api_key"


def _row_to_out(row: sqlite3.Row) -> ModelProviderOut:
    return ModelProviderOut(
        id=row["id"],
        name=row["name"],
        provider_type=row["provider_type"],
        base_url=row["base_url"],
        model=row["model"],
        api_key_ref=row["api_key_ref"],
        has_api_key=bool(row["api_key_ref"]),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def list_all(conn: sqlite3.Connection) -> list[ModelProviderOut]:
    rows = conn.execute(
        "SELECT * FROM model_providers ORDER BY created_at DESC, id"
    ).fetchall()
    return [_row_to_out(r) for r in rows]


def get(conn: sqlite3.Connection, provider_id: str) -> ModelProviderOut | None:
    row = conn.execute(
        "SELECT * FROM model_providers WHERE id = ?", (provider_id,)
    ).fetchone()
    return _row_to_out(row) if row else None


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
        "(id, name, provider_type, base_url, model, api_key_ref, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            provider_id,
            data.name,
            data.provider_type,
            data.base_url,
            data.model,
            api_key_ref,
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

    api_key_ref = existing["api_key_ref"]
    if has_value(data.api_key):
        api_key_ref = keyring_store.save_secret(
            KEYRING_SCOPE, _secret_name(provider_id), data.api_key  # type: ignore[arg-type]
        )

    conn.execute(
        "UPDATE model_providers SET name=?, provider_type=?, base_url=?, model=?, "
        "api_key_ref=?, updated_at=? WHERE id=?",
        (name, provider_type, base_url, model, api_key_ref, utcnow(), provider_id),
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
    audit.record(conn, "model_provider.delete", {"id": provider_id})
    conn.commit()
    return True
