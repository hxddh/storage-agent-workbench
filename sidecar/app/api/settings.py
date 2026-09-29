"""Preferences, skills and the standing-instructions status.

Secrets never live here — they are in the encrypted vault.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..agent import standing
from ..core import store
from ..db import get_conn
from ..security import keyring_store
from ..skills import loader as skill_loader

router = APIRouter(tags=["settings"])

PREFERENCES = {"language": ("en", "zh"), "theme": ("system", "light", "dark")}


class PreferencesIn(BaseModel):
    language: str | None = None
    theme: str | None = None


def preferences(conn: Any) -> dict[str, str]:
    rows = {r["key"]: r["value"] for r in conn.execute(
        "SELECT key, value FROM settings WHERE key IN (%s)" % ",".join("?" * len(PREFERENCES)),
        tuple(PREFERENCES)).fetchall()}
    out = {k: rows.get(k, allowed[0]) for k, allowed in PREFERENCES.items()}
    # No language chosen yet: the window follows the system's and tells us.
    out["language"] = rows.get("language")  # type: ignore[assignment]
    return out


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


@router.get("/skills")
def list_skills() -> dict[str, Any]:
    items = skill_loader.load_registry()
    return {"skills": [{"name": m.name, "description": m.description, "domains": list(m.domains),
                        "user": skill_loader._is_user_skill_path(m.path)} for m in items],
            "dirs": [str(d) for d in skill_loader._user_skills_dirs()]}  # type: ignore[attr-defined]
