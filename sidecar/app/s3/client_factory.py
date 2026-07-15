"""Build boto3 S3 clients from stored cloud-provider configuration.

Secrets are resolved from the system keyring at call time and passed only to
botocore. They are never returned, logged, or persisted. The plaintext lives
only in local variables for the lifetime of the client.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass

import boto3
from botocore import UNSIGNED
from botocore.client import BaseClient
from botocore.config import Config

from ..security import keyring_store

# Sensible local defaults so a misconfigured endpoint fails fast instead of
# hanging the sidecar.
_CONNECT_TIMEOUT = 5
_READ_TIMEOUT = 15
_MAX_ATTEMPTS = 2


class ProviderNotFound(Exception):
    """Raised when a cloud_provider row does not exist."""


@dataclass
class ProviderConfig:
    id: str
    name: str
    provider_type: str
    endpoint_url: str | None
    region: str | None
    addressing_style: str | None
    signature_version: str | None
    access_key_ref: str | None
    secret_key_ref: str | None
    session_token_ref: str | None


def load_provider(conn: sqlite3.Connection, provider_id: str) -> ProviderConfig:
    row = conn.execute(
        "SELECT * FROM cloud_providers WHERE id = ?", (provider_id,)
    ).fetchone()
    if row is None:
        raise ProviderNotFound(provider_id)
    return ProviderConfig(
        id=row["id"],
        name=row["name"],
        provider_type=row["provider_type"],
        endpoint_url=row["endpoint_url"],
        region=row["region"],
        addressing_style=row["addressing_style"],
        signature_version=row["signature_version"],
        access_key_ref=row["access_key_ref"],
        secret_key_ref=row["secret_key_ref"],
        session_token_ref=row["session_token_ref"],
    )


def _resolve(ref: str | None) -> str | None:
    if not ref:
        return None
    scope, name = keyring_store.parse_ref(ref)
    return keyring_store.get_secret(scope, name)


def build_s3_client(
    conn: sqlite3.Connection,
    provider_id: str,
    addressing_style_override: str | None = None,
) -> BaseClient:
    """Create a boto3 S3 client for the given provider.

    ``addressing_style_override`` lets the path-style/virtual-host probe force a
    specific addressing style without mutating stored configuration.
    """
    cfg = load_provider(conn, provider_id)

    access_key = _resolve(cfg.access_key_ref)
    secret_key = _resolve(cfg.secret_key_ref)
    session_token = _resolve(cfg.session_token_ref)

    # Default addressing: virtual-hosted for AWS (no endpoint), but PATH-style
    # when a custom endpoint is set — most S3-compatible endpoints (MinIO/Ceph on
    # an IP/host without wildcard DNS) require path-style, so virtual-hosting them
    # by default fails every call.
    default_addressing = "path" if cfg.endpoint_url else "virtual"
    addressing_style = addressing_style_override or cfg.addressing_style or default_addressing
    signature_version = cfg.signature_version or "s3v4"

    # Credentials: sign only when BOTH keys are present. When they aren't, sign
    # ANONYMOUSLY (UNSIGNED) rather than letting botocore fall back to the host's
    # ambient AWS credentials (env vars / instance metadata) — that would be a
    # confused-deputy: the operator configured "no credentials", so calls must
    # NOT silently use the host identity. (Anonymous access still works for a
    # genuinely public bucket; a private one fails clearly instead of leaking.)
    signed = bool(access_key and secret_key)
    boto_config = Config(
        signature_version=signature_version if signed else UNSIGNED,
        s3={"addressing_style": addressing_style},
        connect_timeout=_CONNECT_TIMEOUT,
        read_timeout=_READ_TIMEOUT,
        retries={"max_attempts": _MAX_ATTEMPTS, "mode": "standard"},
    )

    kwargs: dict = {}
    if signed:
        kwargs = {
            "aws_access_key_id": access_key,
            "aws_secret_access_key": secret_key,
            "aws_session_token": session_token or None,
        }
    return boto3.client(
        "s3",
        endpoint_url=cfg.endpoint_url or None,
        # botocore requires a region for SigV4; default for custom endpoints.
        region_name=cfg.region or "us-east-1",
        config=boto_config,
        **kwargs,
    )
