"""App settings endpoints: secret-vault status.

Secrets are NEVER stored here (they live only in the encrypted local vault).
There is no autonomy toggle: the in-chat agent is always a fully autonomous
read-only investigator, so there is nothing to configure.
"""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from ..security import keyring_store

router = APIRouter(prefix="/settings", tags=["settings"])


class VaultStatusOut(BaseModel):
    unreadable: bool
    backup_present: bool


@router.get("/secret-vault", response_model=VaultStatusOut)
def get_secret_vault_status() -> VaultStatusOut:
    """Whether the encrypted secret vault failed to decrypt this session (so the
    UI can warn instead of showing keys as merely 'not set')."""
    return VaultStatusOut(**keyring_store.vault_status())
