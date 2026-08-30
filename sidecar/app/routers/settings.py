"""App settings endpoints: secret-vault status and the local price table.

Secrets are NEVER stored here (they live only in the encrypted local vault).
The storage price table is ordinary configuration — example rates until the
operator confirms they have calibrated it. It must never contain credentials.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from ..analysis import prices
from ..db import get_conn
from ..security import keyring_store

router = APIRouter(prefix="/settings", tags=["settings"])


class VaultStatusOut(BaseModel):
    unreadable: bool
    backup_present: bool


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
