"""Storage accounts (v5).

Credentials live in the vault (scope ``cloud_provider``); SQLite holds only
``keyring://`` references. Bucket/prefix scope is enforced server-side by every
tool through ``s3.scope.check_scope``.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, Field

from ..repositories import has_value, utcnow
from ..security import keyring_store

KEYRING_SCOPE = "cloud_provider"
_SECRET_FIELDS = ("access_key", "secret_key", "session_token")


@dataclass
class Cloud:
    id: str
    name: str
    provider_type: str
    endpoint_url: str | None
    region: str | None
    addressing_style: str | None
    signature_version: str | None
    allowed_buckets: list[str] = field(default_factory=list)
    allowed_prefixes: list[str] = field(default_factory=list)
    has_access_key: bool = False
    has_secret_key: bool = False
    has_session_token: bool = False
    created_at: str = ""
    updated_at: str = ""

    def public(self) -> dict[str, Any]:
        return {k: getattr(self, k) for k in self.__dataclass_fields__}


class CloudIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    provider_type: str = Field(min_length=1, max_length=40)
    endpoint_url: str | None = None
    region: str | None = None
    addressing_style: str | None = "virtual"
    signature_version: str | None = "s3v4"
    access_key: str | None = None
    secret_key: str | None = None
    session_token: str | None = None
    allowed_buckets: list[str] = Field(default_factory=list)
    allowed_prefixes: list[str] = Field(default_factory=list)


class CloudPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    provider_type: str | None = None
    endpoint_url: str | None = None
    region: str | None = None
    addressing_style: str | None = None
    signature_version: str | None = None
    access_key: str | None = None
    secret_key: str | None = None
    session_token: str | None = None   # "" clears it
    allowed_buckets: list[str] | None = None
    allowed_prefixes: list[str] | None = None


def _secret_name(provider_id: str, suffix: str) -> str:
    return f"{provider_id}/{suffix}"


def _cloud(row: sqlite3.Row) -> Cloud:
    return Cloud(
        id=row["id"], name=row["name"], provider_type=row["provider_type"],
        endpoint_url=row["endpoint_url"], region=row["region"],
        addressing_style=row["addressing_style"], signature_version=row["signature_version"],
        allowed_buckets=json.loads(row["allowed_buckets_json"] or "[]"),
        allowed_prefixes=json.loads(row["allowed_prefixes_json"] or "[]"),
        has_access_key=keyring_store.secret_exists(row["access_key_ref"]),
        has_secret_key=keyring_store.secret_exists(row["secret_key_ref"]),
        has_session_token=keyring_store.secret_exists(row["session_token_ref"]),
        created_at=row["created_at"], updated_at=row["updated_at"],
    )


def list_all(conn: sqlite3.Connection) -> list[Cloud]:
    return [_cloud(r) for r in conn.execute("SELECT * FROM cloud_providers ORDER BY created_at, rowid").fetchall()]


def get(conn: sqlite3.Connection, provider_id: str) -> Cloud | None:
    row = conn.execute("SELECT * FROM cloud_providers WHERE id = ?", (provider_id,)).fetchone()
    return _cloud(row) if row else None


def create(conn: sqlite3.Connection, data: CloudIn) -> Cloud:
    pid = uuid.uuid4().hex
    now = utcnow()
    refs: dict[str, str | None] = {}
    for f in _SECRET_FIELDS:
        value = getattr(data, f)
        refs[f] = keyring_store.save_secret(KEYRING_SCOPE, _secret_name(pid, f), value) if has_value(value) else None
    conn.execute(
        "INSERT INTO cloud_providers (id, name, provider_type, endpoint_url, region, addressing_style, "
        "signature_version, access_key_ref, secret_key_ref, session_token_ref, allowed_buckets_json, "
        "allowed_prefixes_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (pid, data.name, data.provider_type, data.endpoint_url or None, data.region or None,
         data.addressing_style, data.signature_version, refs["access_key"], refs["secret_key"],
         refs["session_token"], json.dumps(data.allowed_buckets), json.dumps(data.allowed_prefixes), now, now))
    conn.commit()
    return get(conn, pid)  # type: ignore[return-value]


def update(conn: sqlite3.Connection, provider_id: str, data: CloudPatch) -> Cloud | None:
    row = conn.execute("SELECT * FROM cloud_providers WHERE id = ?", (provider_id,)).fetchone()
    if row is None:
        return None
    patch = data.model_dump(exclude_unset=True)

    def pick(key: str) -> Any:
        if key not in patch or patch[key] is None:
            return row[key]
        return None if patch[key] == "" else patch[key]

    refs = {f: row[f"{f}_ref"] for f in _SECRET_FIELDS}
    for f in _SECRET_FIELDS:
        value = patch.get(f)
        if has_value(value):
            refs[f] = keyring_store.save_secret(KEYRING_SCOPE, _secret_name(provider_id, f), value)
        elif f == "session_token" and value == "" and refs[f]:
            keyring_store.delete_secret(KEYRING_SCOPE, _secret_name(provider_id, f))
            refs[f] = None
    buckets = json.dumps(patch["allowed_buckets"]) if patch.get("allowed_buckets") is not None \
        else row["allowed_buckets_json"]
    prefixes = json.dumps(patch["allowed_prefixes"]) if patch.get("allowed_prefixes") is not None \
        else row["allowed_prefixes_json"]
    conn.execute(
        "UPDATE cloud_providers SET name=?, provider_type=?, endpoint_url=?, region=?, addressing_style=?, "
        "signature_version=?, access_key_ref=?, secret_key_ref=?, session_token_ref=?, allowed_buckets_json=?, "
        "allowed_prefixes_json=?, updated_at=? WHERE id=?",
        (patch.get("name") or row["name"], patch.get("provider_type") or row["provider_type"],
         pick("endpoint_url"), pick("region"), pick("addressing_style"), pick("signature_version"),
         refs["access_key"], refs["secret_key"], refs["session_token"], buckets, prefixes, utcnow(), provider_id))
    conn.commit()
    from ..s3 import client_factory
    client_factory.invalidate_provider(provider_id)
    return get(conn, provider_id)


def delete(conn: sqlite3.Connection, provider_id: str) -> bool:
    if conn.execute("SELECT 1 FROM cloud_providers WHERE id = ?", (provider_id,)).fetchone() is None:
        return False
    for f in _SECRET_FIELDS:
        keyring_store.delete_secret(KEYRING_SCOPE, _secret_name(provider_id, f))
    conn.execute("DELETE FROM cloud_providers WHERE id = ?", (provider_id,))
    conn.commit()
    from ..s3 import client_factory
    client_factory.invalidate_provider(provider_id)
    return True
