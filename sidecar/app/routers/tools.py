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
    BucketConfigRequest,
    HeadBucketRequest,
    HeadObjectRequest,
    InspectTlsRequest,
    ListObjectsV2Request,
    PathStyleRequest,
    PerformanceProfileRequest,
    TestCredentialsRequest,
    TestRangeGetRequest,
)
from ..s3 import config_tools, tools
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


# --- read-only bucket config review tools (Phase 06) ------------------------


def _config_tool(conn, name: str, body: BucketConfigRequest, fn) -> dict[str, Any]:
    return run_tool(conn, name, {"provider_id": body.provider_id, "bucket": body.bucket}, fn)


@router.post("/get-bucket-config-summary")
def tool_get_bucket_config_summary(
    body: BucketConfigRequest, conn: sqlite3.Connection = Depends(get_conn)
) -> dict[str, Any]:
    return _config_tool(conn, "get_bucket_config_summary", body,
                        lambda: config_tools.get_bucket_config_summary(conn, body.provider_id, body.bucket))


@router.post("/review-bucket-security")
def tool_review_bucket_security(
    body: BucketConfigRequest, conn: sqlite3.Connection = Depends(get_conn)
) -> dict[str, Any]:
    return _config_tool(conn, "review_bucket_security", body,
                        lambda: config_tools.review_bucket_security(conn, body.provider_id, body.bucket))


@router.post("/review-bucket-lifecycle")
def tool_review_bucket_lifecycle(
    body: BucketConfigRequest, conn: sqlite3.Connection = Depends(get_conn)
) -> dict[str, Any]:
    return _config_tool(conn, "review_bucket_lifecycle", body,
                        lambda: config_tools.review_bucket_lifecycle(conn, body.provider_id, body.bucket))


@router.post("/review-bucket-observability")
def tool_review_bucket_observability(
    body: BucketConfigRequest, conn: sqlite3.Connection = Depends(get_conn)
) -> dict[str, Any]:
    return _config_tool(conn, "review_bucket_observability", body,
                        lambda: config_tools.review_bucket_observability(conn, body.provider_id, body.bucket))


@router.post("/review-bucket-cost-optimization")
def tool_review_bucket_cost_optimization(
    body: BucketConfigRequest, conn: sqlite3.Connection = Depends(get_conn)
) -> dict[str, Any]:
    return _config_tool(conn, "review_bucket_cost_optimization", body,
                        lambda: config_tools.review_bucket_cost_optimization(conn, body.provider_id, body.bucket))


@router.post("/review-bucket-performance-profile")
def tool_review_bucket_performance_profile(
    body: PerformanceProfileRequest, conn: sqlite3.Connection = Depends(get_conn)
) -> dict[str, Any]:
    return run_tool(
        conn, "review_bucket_performance_profile",
        {"provider_id": body.provider_id, "bucket": body.bucket, "prefix": body.prefix},
        lambda: config_tools.review_bucket_performance_profile(conn, body.provider_id, body.bucket, body.prefix),
    )
