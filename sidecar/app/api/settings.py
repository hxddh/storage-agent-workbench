"""Preferences, the price table, skills and the standing-instructions status.

Secrets never live here — they are in the encrypted vault. The price table is
ordinary configuration (example rates until the user confirms them).
"""

from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..agent import standing
from ..analysis import prices
from ..core import store
from ..db import get_conn
from ..security import keyring_store
from ..skills import context as skill_context
from ..skills import loader as skill_loader

router = APIRouter(tags=["settings"])

PREFERENCES = {"language": ("en", "zh"), "theme": ("system", "light", "dark")}
_NAME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9_-]{1,64}$")


class PreferencesIn(BaseModel):
    language: str | None = None
    theme: str | None = None


class PriceTableIn(BaseModel):
    confirmed: bool | None = None
    rates: dict[str, Any] | None = None
    note: str | None = Field(default=None, max_length=800)


def preferences(conn: Any) -> dict[str, str]:
    rows = {r["key"]: r["value"] for r in conn.execute(
        "SELECT key, value FROM settings WHERE key IN (%s)" % ",".join("?" * len(PREFERENCES)),
        tuple(PREFERENCES)).fetchall()}
    return {k: rows.get(k, allowed[0]) for k, allowed in PREFERENCES.items()}


@router.get("/settings")
def get_settings(conn: Any = Depends(get_conn)) -> dict[str, Any]:
    return {**preferences(conn), "vault": keyring_store.vault_status(), "instructions": standing.status()}


@router.patch("/settings")
def patch_settings(body: PreferencesIn, conn: Any = Depends(get_conn)) -> dict[str, Any]:
    for key, value in body.model_dump(exclude_none=True).items():
        if value not in PREFERENCES[key]:
            raise HTTPException(status_code=422, detail=f"{key} must be one of {', '.join(PREFERENCES[key])}")
        conn.execute("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) "
                     "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                     (key, value, store.utcnow()))
    conn.commit()
    return get_settings(conn)


@router.get("/settings/price-table")
def get_price_table(conn: Any = Depends(get_conn)) -> dict[str, Any]:
    return prices.load(conn)


@router.put("/settings/price-table")
def put_price_table(body: PriceTableIn, conn: Any = Depends(get_conn)) -> dict[str, Any]:
    out = prices.save(conn, rates=body.rates, confirmed=body.confirmed, note=body.note)
    store.audit(conn, actor="user", action="settings.price_table", detail={"confirmed": out["confirmed"]})
    return out


@router.get("/skills")
def list_skills() -> dict[str, Any]:
    items = skill_loader.load_registry()
    return {"skills": [{"name": m.name, "description": m.description, "domains": list(m.domains),
                        "user": skill_loader._is_user_skill_path(m.path)} for m in items],
            "dirs": [str(d) for d in skill_loader._user_skills_dirs()]}  # type: ignore[attr-defined]


@router.get("/skills/{name}")
def get_skill(name: str) -> dict[str, Any]:
    if not _NAME_RE.fullmatch(name):
        raise HTTPException(status_code=400, detail="invalid skill name")
    body = skill_context.read_skill_text(name)
    if body is None:
        raise HTTPException(status_code=404, detail="skill not found")
    return {"name": name, "body": body}
