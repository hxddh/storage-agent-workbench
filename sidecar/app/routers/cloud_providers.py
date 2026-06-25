"""Cloud provider CRUD.

Phase 02 stores configuration and secret references only. No S3 calls, no
credential validation against a live endpoint, no destructive operations.
"""

from __future__ import annotations

import sqlite3

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response, status

from ..db import get_conn
from ..models.schemas import (
    CloudProviderCreate,
    CloudProviderOut,
    CloudProviderUpdate,
)
from ..repositories import cloud_providers as repo
from ..s3 import tools
from ..tool_runner import run_tool

router = APIRouter(prefix="/cloud-providers", tags=["cloud-providers"])


@router.get("", response_model=list[CloudProviderOut])
def list_cloud_providers(conn: sqlite3.Connection = Depends(get_conn)):
    return repo.list_all(conn)


@router.post("", response_model=CloudProviderOut, status_code=status.HTTP_201_CREATED)
def create_cloud_provider(
    body: CloudProviderCreate, conn: sqlite3.Connection = Depends(get_conn)
):
    return repo.create(conn, body)


@router.put("/{provider_id}", response_model=CloudProviderOut)
def update_cloud_provider(
    provider_id: str,
    body: CloudProviderUpdate,
    conn: sqlite3.Connection = Depends(get_conn),
):
    result = repo.update(conn, provider_id, body)
    if result is None:
        raise HTTPException(status_code=404, detail="cloud provider not found")
    return result


@router.delete("/{provider_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_cloud_provider(
    provider_id: str, conn: sqlite3.Connection = Depends(get_conn)
):
    if not repo.delete(conn, provider_id):
        raise HTTPException(status_code=404, detail="cloud provider not found")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{provider_id}/test")
def test_cloud_provider(
    provider_id: str, conn: sqlite3.Connection = Depends(get_conn)
) -> dict[str, Any]:
    """Run a real READ-ONLY connection test (test_credentials) for the provider.

    Reads credentials from the keyring, makes a lightweight read-only call, and
    returns a sanitized result. Never returns AK/SK. Records a tool_call + audit
    entry like any other tool invocation.
    """
    if repo.get(conn, provider_id) is None:
        raise HTTPException(status_code=404, detail="cloud provider not found")
    return run_tool(
        conn,
        "test_credentials",
        {"provider_id": provider_id, "via": "cloud-provider-test"},
        lambda: tools.test_credentials(conn, provider_id),
    )
