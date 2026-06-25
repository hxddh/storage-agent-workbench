"""HTTP endpoints for the whitelisted READ-ONLY S3 tools.

Each endpoint records a sanitized tool_call + audit entry via ``run_tool``.
Responses never contain credentials. There are no write/delete endpoints.
"""

from __future__ import annotations

import sqlite3
from typing import Any
from urllib.parse import urlparse, urlunparse

from fastapi import APIRouter, Depends

from ..db import get_conn
from ..models.schemas import (
    HeadBucketRequest,
    HeadObjectRequest,
    InspectTlsRequest,
    ListObjectsV2Request,
    PathStyleRequest,
    TestCredentialsRequest,
    TestRangeGetRequest,
)
from ..s3 import tools
from ..tool_runner import run_tool

router = APIRouter(prefix="/tools", tags=["tools"])


def _strip_query(url: str) -> str:
    """Drop the query string so sensitive presigned params are never recorded."""
    p = urlparse(url if "://" in url else f"https://{url}")
    return urlunparse((p.scheme, p.netloc, p.path, "", "", ""))


@router.post("/test-credentials")
def tool_test_credentials(
    body: TestCredentialsRequest, conn: sqlite3.Connection = Depends(get_conn)
) -> dict[str, Any]:
    return run_tool(
        conn,
        "test_credentials",
        {"provider_id": body.provider_id},
        lambda: tools.test_credentials(conn, body.provider_id),
    )


@router.post("/head-bucket")
def tool_head_bucket(
    body: HeadBucketRequest, conn: sqlite3.Connection = Depends(get_conn)
) -> dict[str, Any]:
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


@router.post("/head-object")
def tool_head_object(
    body: HeadObjectRequest, conn: sqlite3.Connection = Depends(get_conn)
) -> dict[str, Any]:
    return run_tool(
        conn,
        "head_object",
        {"provider_id": body.provider_id, "bucket": body.bucket, "key": body.key},
        lambda: tools.head_object(conn, body.provider_id, body.bucket, body.key),
    )


@router.post("/test-range-get")
def tool_test_range_get(
    body: TestRangeGetRequest, conn: sqlite3.Connection = Depends(get_conn)
) -> dict[str, Any]:
    return run_tool(
        conn,
        "test_range_get",
        {
            "provider_id": body.provider_id,
            "bucket": body.bucket,
            "key": body.key,
            "range_header": body.range_header,
        },
        lambda: tools.test_range_get(
            conn, body.provider_id, body.bucket, body.key, body.range_header
        ),
    )


@router.post("/test-path-style-vs-virtual-host")
def tool_test_path_style(
    body: PathStyleRequest, conn: sqlite3.Connection = Depends(get_conn)
) -> dict[str, Any]:
    return run_tool(
        conn,
        "test_path_style_vs_virtual_host",
        {"provider_id": body.provider_id, "bucket": body.bucket},
        lambda: tools.test_path_style_vs_virtual_host(conn, body.provider_id, body.bucket),
    )


@router.post("/inspect-tls")
def tool_inspect_tls(
    body: InspectTlsRequest, conn: sqlite3.Connection = Depends(get_conn)
) -> dict[str, Any]:
    # Record only the query-stripped endpoint.
    safe_endpoint = _strip_query(body.endpoint_url)
    return run_tool(
        conn,
        "inspect_tls",
        {"endpoint_url": safe_endpoint},
        lambda: tools.inspect_tls(body.endpoint_url),
    )
