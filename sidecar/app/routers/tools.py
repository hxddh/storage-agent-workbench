"""HTTP endpoints for the whitelisted READ-ONLY S3 tools.

Only the two endpoints the frontend actually calls survive here —
``/tools/head-bucket`` and ``/tools/list-objects-v2``. Every other former
``/tools/*`` HTTP wrapper was removed: those S3-layer functions are still used
by the conversational agent and the run executors (which call them directly),
they just no longer need a bespoke, unscoped HTTP surface. Tests exercise the
deleted wrappers by calling the s3-layer functions directly.

Each endpoint records a sanitized tool_call + audit entry via ``run_tool`` and
enforces the provider's ``allowed_buckets`` / ``allowed_prefixes`` scope (so the
restriction isn't decorative outside the agent). Responses never contain
credentials. There are no write/delete endpoints.
"""

from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from ..db import get_conn
from ..models.schemas import HeadBucketRequest, ListObjectsV2Request
from ..repositories import cloud_providers as cloud_repo
from ..s3 import tools
from ..s3.scope import check_scope
from ..tool_runner import run_tool

router = APIRouter(prefix="/tools", tags=["tools"])


def _enforce_scope(conn: sqlite3.Connection, provider_id: str, bucket: str,
                   *, prefix: str | None = None) -> None:
    """Deny an out-of-scope bucket/prefix for a provider (403), if restricted."""
    provider = cloud_repo.get(conn, provider_id)
    if provider is None:
        return  # unknown provider surfaces downstream as a tool error, not here
    denial = check_scope(provider.allowed_buckets, provider.allowed_prefixes,
                         bucket, prefix=prefix)
    if denial:
        raise HTTPException(status_code=403, detail=denial)


@router.post("/head-bucket")
def tool_head_bucket(
    body: HeadBucketRequest, conn: sqlite3.Connection = Depends(get_conn)
) -> dict[str, Any]:
    _enforce_scope(conn, body.provider_id, body.bucket)
    return run_tool(
        conn,
        "head_bucket",
        {"provider_id": body.provider_id, "bucket": body.bucket},
        lambda: tools.head_bucket(conn, body.provider_id, body.bucket),
    )


@router.post("/list-objects-v2")
def tool_list_objects_v2(
    body: ListObjectsV2Request, conn: sqlite3.Connection = Depends(get_conn)
) -> dict[str, Any]:
    _enforce_scope(conn, body.provider_id, body.bucket, prefix=body.prefix)
    return run_tool(
        conn,
        "list_objects_v2",
        {
            "provider_id": body.provider_id,
            "bucket": body.bucket,
            "max_keys": body.max_keys,
            "prefix": body.prefix,
        },
        lambda: tools.list_objects_v2(
            conn, body.provider_id, body.bucket, body.max_keys, body.prefix
        ),
    )
