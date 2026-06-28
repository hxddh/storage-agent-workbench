"""App settings endpoints. Currently the agent autonomy policy.

Secrets are NEVER stored here (they live only in the OS keychain); this is a
small non-sensitive key/value store.
"""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import audit
from ..agent_runtime import autonomy
from ..db import get_conn
from ..repositories import settings as settings_repo

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
