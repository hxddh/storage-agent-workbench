"""Cloud provider repository."""

from __future__ import annotations

import json
import sqlite3
import uuid

from .. import audit
from ..models.schemas import (
    CloudProviderCreate,
    CloudProviderOut,
    CloudProviderUpdate,
)
from ..security import keyring_store
from . import has_value, utcnow

KEYRING_SCOPE = "cloud_provider"

# field name -> keyring secret suffix
_SECRET_FIELDS = {
    "access_key": "access_key",
    "secret_key": "secret_key",
    "session_token": "session_token",
}


def _secret_name(provider_id: str, field: str) -> str:
    return f"{provider_id}/{field}"


def _row_to_out(row: sqlite3.Row) -> CloudProviderOut:
    return CloudProviderOut(
        id=row["id"],
        name=row["name"],
        provider_type=row["provider_type"],
        endpoint_url=row["endpoint_url"],
        region=row["region"],
        addressing_style=row["addressing_style"],
        signature_version=row["signature_version"],
        access_key_ref=row["access_key_ref"],
        secret_key_ref=row["secret_key_ref"],
        session_token_ref=row["session_token_ref"],
        has_access_key=keyring_store.secret_exists(row["access_key_ref"]),
        has_secret_key=keyring_store.secret_exists(row["secret_key_ref"]),
        has_session_token=keyring_store.secret_exists(row["session_token_ref"]),
        mode=row["mode"],
        allowed_buckets=json.loads(row["allowed_buckets_json"] or "[]"),
        allowed_prefixes=json.loads(row["allowed_prefixes_json"] or "[]"),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def list_all(conn: sqlite3.Connection) -> list[CloudProviderOut]:
    rows = conn.execute(
        "SELECT * FROM cloud_providers ORDER BY created_at DESC, id"
    ).fetchall()
    return [_row_to_out(r) for r in rows]


def get(conn: sqlite3.Connection, provider_id: str) -> CloudProviderOut | None:
    row = conn.execute(
        "SELECT * FROM cloud_providers WHERE id = ?", (provider_id,)
    ).fetchone()
    return _row_to_out(row) if row else None


def create(conn: sqlite3.Connection, data: CloudProviderCreate) -> CloudProviderOut:
    provider_id = uuid.uuid4().hex
    now = utcnow()

    refs: dict[str, str | None] = {f: None for f in _SECRET_FIELDS}
    for field, suffix in _SECRET_FIELDS.items():
        value = getattr(data, field)
        if has_value(value):
            refs[field] = keyring_store.save_secret(
                KEYRING_SCOPE, _secret_name(provider_id, suffix), value
            )

    conn.execute(
        "INSERT INTO cloud_providers "
        "(id, name, provider_type, endpoint_url, region, addressing_style, "
        " signature_version, access_key_ref, secret_key_ref, session_token_ref, "
        " mode, allowed_buckets_json, allowed_prefixes_json, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            provider_id,
            data.name,
            data.provider_type,
            data.endpoint_url,
            data.region,
            data.addressing_style,
            data.signature_version,
            refs["access_key"],
            refs["secret_key"],
            refs["session_token"],
            data.mode,
            json.dumps(data.allowed_buckets),
            json.dumps(data.allowed_prefixes),
            now,
            now,
        ),
    )
    audit.record(
        conn,
        "cloud_provider.create",
        {
            "id": provider_id,
            "name": data.name,
            "provider_type": data.provider_type,
            "mode": data.mode,
        },
    )
    conn.commit()
    return get(conn, provider_id)  # type: ignore[return-value]


def update(
    conn: sqlite3.Connection, provider_id: str, data: CloudProviderUpdate
) -> CloudProviderOut | None:
    existing = conn.execute(
        "SELECT * FROM cloud_providers WHERE id = ?", (provider_id,)
    ).fetchone()
    if existing is None:
        return None

    def pick(field: str):
        val = getattr(data, field)
        return val if val is not None else existing[field]

    name = pick("name")
    provider_type = pick("provider_type")
    endpoint_url = pick("endpoint_url")
    region = pick("region")
    addressing_style = pick("addressing_style")
    signature_version = pick("signature_version")
    mode = data.mode if data.mode is not None else existing["mode"]

    allowed_buckets_json = (
        json.dumps(data.allowed_buckets)
        if data.allowed_buckets is not None
        else existing["allowed_buckets_json"]
    )
    allowed_prefixes_json = (
        json.dumps(data.allowed_prefixes)
        if data.allowed_prefixes is not None
        else existing["allowed_prefixes_json"]
    )

    refs = {
        "access_key": existing["access_key_ref"],
        "secret_key": existing["secret_key_ref"],
        "session_token": existing["session_token_ref"],
    }
    rotated: list[str] = []
    for field, suffix in _SECRET_FIELDS.items():
        value = getattr(data, field)
        if has_value(value):
            refs[field] = keyring_store.save_secret(
                KEYRING_SCOPE, _secret_name(provider_id, suffix), value
            )
            rotated.append(field)

    conn.execute(
        "UPDATE cloud_providers SET name=?, provider_type=?, endpoint_url=?, region=?, "
        "addressing_style=?, signature_version=?, access_key_ref=?, secret_key_ref=?, "
        "session_token_ref=?, mode=?, allowed_buckets_json=?, allowed_prefixes_json=?, "
        "updated_at=? WHERE id=?",
        (
            name,
            provider_type,
            endpoint_url,
            region,
            addressing_style,
            signature_version,
            refs["access_key"],
            refs["secret_key"],
            refs["session_token"],
            mode,
            allowed_buckets_json,
            allowed_prefixes_json,
            utcnow(),
            provider_id,
        ),
    )
    audit.record(
        conn,
        "cloud_provider.update",
        {"id": provider_id, "rotated_secrets": rotated, "mode": mode},
    )
    conn.commit()
    return get(conn, provider_id)


def delete(conn: sqlite3.Connection, provider_id: str) -> bool:
    row = conn.execute(
        "SELECT id FROM cloud_providers WHERE id = ?", (provider_id,)
    ).fetchone()
    if row is None:
        return False

    for suffix in _SECRET_FIELDS.values():
        keyring_store.delete_secret(KEYRING_SCOPE, _secret_name(provider_id, suffix))
    conn.execute("DELETE FROM cloud_providers WHERE id = ?", (provider_id,))
    audit.record(conn, "cloud_provider.delete", {"id": provider_id})
    conn.commit()
    return True
