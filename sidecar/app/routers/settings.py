"""App settings endpoints: agent autonomy policy + secret-vault status.

Secrets are NEVER stored here (they live only in the encrypted local vault);
this is a small non-sensitive key/value store.
"""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import audit
from ..agent_runtime import autonomy
from ..db import get_conn
from ..repositories import settings as settings_repo
from ..security import keyring_store

router = APIRouter(prefix="/settings", tags=["settings"])


class AutonomyOut(BaseModel):
    policy: str
    policies: list[str]
    default: str


class AutonomyUpdate(BaseModel):
    policy: str


@router.get("/autonomy", response_model=AutonomyOut)
def get_autonomy(conn: sqlite3.Connection = Depends(get_conn)) -> AutonomyOut:
    return AutonomyOut(
        policy=settings_repo.get_autonomy_policy(conn),
        policies=list(autonomy.POLICIES),
        default=autonomy.DEFAULT_POLICY,
    )


@router.put("/autonomy", response_model=AutonomyOut)
def set_autonomy(body: AutonomyUpdate, conn: sqlite3.Connection = Depends(get_conn)) -> AutonomyOut:
    if body.policy not in autonomy.POLICIES:
        raise HTTPException(status_code=422, detail=f"policy must be one of {list(autonomy.POLICIES)}")
    stored = settings_repo.set_autonomy_policy(conn, body.policy)
    audit.record(conn, "settings.autonomy", {"policy": stored}, run_id=None)
    conn.commit()
    return AutonomyOut(policy=stored, policies=list(autonomy.POLICIES), default=autonomy.DEFAULT_POLICY)


class VaultStatusOut(BaseModel):
    unreadable: bool
    backup_present: bool


@router.get("/secret-vault", response_model=VaultStatusOut)
def get_secret_vault_status() -> VaultStatusOut:
    """Whether the encrypted secret vault failed to decrypt this session (so the
    UI can warn instead of showing keys as merely 'not set')."""
    return VaultStatusOut(**keyring_store.vault_status())
