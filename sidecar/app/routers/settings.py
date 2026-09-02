"""App settings endpoints: secret-vault status, the local price table, the
approval policy (v1.12) and the instructions-file status (v1.12).

Secrets are NEVER stored here (they live only in the encrypted local vault).
The storage price table is ordinary configuration — example rates until the
operator confirms they have calibrated it. It must never contain credentials.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from ..agent_runtime import instructions
from ..analysis import prices
from ..db import get_conn
from ..security import keyring_store
from ..task_runtime import approval_policy

router = APIRouter(prefix="/settings", tags=["settings"])


class VaultStatusOut(BaseModel):
    unreadable: bool
    backup_present: bool


class ApprovalPolicyIn(BaseModel):
    policy: str = Field(pattern="^(ask|allow_session|allow_always)$")


class PriceTableIn(BaseModel):
    confirmed: bool | None = None
    rates: dict[str, Any] | None = None
    note: str | None = Field(default=None, max_length=800)


@router.get("/secret-vault", response_model=VaultStatusOut)
def get_secret_vault_status() -> VaultStatusOut:
    """Whether the encrypted secret vault failed to decrypt this session (so the
    UI can warn instead of showing keys as merely 'not set')."""
    return VaultStatusOut(**keyring_store.vault_status())


@router.get("/price-table")
def get_price_table(conn=Depends(get_conn)) -> dict[str, Any]:
    return prices.load(conn)


@router.put("/price-table")
def put_price_table(body: PriceTableIn, conn=Depends(get_conn)) -> dict[str, Any]:
    return prices.save(conn, rates=body.rates, confirmed=body.confirmed, note=body.note)


@router.get("/approval-policy")
def get_approval_policy(conn=Depends(get_conn)) -> dict[str, Any]:
    """The policy in force plus the gated tools it can answer (Safety pane)."""
    return approval_policy.describe(conn)


@router.put("/approval-policy")
def put_approval_policy(body: ApprovalPolicyIn, conn=Depends(get_conn)) -> dict[str, Any]:
    approval_policy.set(conn, body.policy)
    conn.commit()
    return approval_policy.describe(conn)


@router.get("/instructions")
def get_instructions_status() -> dict[str, Any]:
    """Whether an AGENTS.md instructions file is loaded (never its text)."""
    return instructions.status()
