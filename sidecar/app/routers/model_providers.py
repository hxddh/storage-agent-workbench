"""Model provider CRUD + connectivity test."""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Response, status

from ..db import get_conn
from ..models.schemas import (
    ModelProviderCreate,
    ModelProviderOut,
    ModelProviderTestResult,
    ModelProviderUpdate,
)
from ..repositories import model_providers as repo
from ..security import keyring_store

router = APIRouter(prefix="/model-providers", tags=["model-providers"])


@router.get("", response_model=list[ModelProviderOut])
def list_model_providers(conn: sqlite3.Connection = Depends(get_conn)):
    return repo.list_all(conn)


@router.post("", response_model=ModelProviderOut, status_code=status.HTTP_201_CREATED)
def create_model_provider(
    body: ModelProviderCreate, conn: sqlite3.Connection = Depends(get_conn)
):
    return repo.create(conn, body)


@router.put("/{provider_id}", response_model=ModelProviderOut)
def update_model_provider(
    provider_id: str,
    body: ModelProviderUpdate,
    conn: sqlite3.Connection = Depends(get_conn),
):
    result = repo.update(conn, provider_id, body)
    if result is None:
        raise HTTPException(status_code=404, detail="model provider not found")
    return result


@router.delete("/{provider_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_model_provider(
    provider_id: str, conn: sqlite3.Connection = Depends(get_conn)
):
    if not repo.delete(conn, provider_id):
        raise HTTPException(status_code=404, detail="model provider not found")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{provider_id}/test", response_model=ModelProviderTestResult)
def test_model_provider(
    provider_id: str, conn: sqlite3.Connection = Depends(get_conn)
):
    """Validate that a model provider is configured.

    Phase 02 performs a local configuration check only: it confirms required
    fields are set and that the API key resolves from the keyring. It does NOT
    make a live network call to the provider (that arrives with the agent
    runtime in a later phase). The secret value is never returned.
    """
    provider = repo.get(conn, provider_id)
    if provider is None:
        raise HTTPException(status_code=404, detail="model provider not found")

    has_secret = False
    if provider.api_key_ref:
        scope, name = keyring_store.parse_ref(provider.api_key_ref)
        has_secret = keyring_store.get_secret(scope, name) is not None

    checks = {
        "has_base_url": bool(provider.base_url),
        "has_model": bool(provider.model),
        "api_key_present": has_secret,
    }
    ok = all(checks.values())
    detail = (
        "Configuration looks complete. Live provider ping is deferred to the "
        "agent-runtime phase."
        if ok
        else "Configuration incomplete: " + ", ".join(k for k, v in checks.items() if not v)
    )
    return ModelProviderTestResult(ok=ok, checks=checks, detail=detail)
