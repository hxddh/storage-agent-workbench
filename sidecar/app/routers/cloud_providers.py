"""Cloud provider CRUD.

Phase 02 stores configuration and secret references only. No S3 calls, no
credential validation against a live endpoint, no destructive operations.
"""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Response, status

from ..db import get_conn
from ..models.schemas import (
    CloudProviderCreate,
    CloudProviderOut,
    CloudProviderUpdate,
)
from ..repositories import cloud_providers as repo

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
