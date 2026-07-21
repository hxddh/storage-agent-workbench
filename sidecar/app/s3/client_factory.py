"""Build boto3 S3 clients from stored cloud-provider configuration.

Secrets are resolved from the system keyring at call time and passed only to
botocore. They are never returned, logged, or persisted. The plaintext lives
only in local variables for the lifetime of the client.
"""

from __future__ import annotations

import sqlite3
import threading
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


class CredentialResolutionError(Exception):
    """Raised when a provider has a credential REF configured but its value cannot
    be read from the vault — so the client is NOT silently downgraded to anonymous."""


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
    updated_at: str | None = None


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
        updated_at=row["updated_at"],
    )


# Client cache: building a boto3 client re-reads + re-decrypts the vault and
# re-constructs botocore machinery on EVERY tool call (~50-100ms) — a deep
# 40-probe turn pays that dozens of times. Keyed on (provider_id, addressing
# override, row updated_at): editing the provider changes updated_at, so a stale
# client is never served (it just ages out). boto3 clients are thread-safe for
# request operations. The CACHE holds clients only — never plaintext secrets.
_CLIENT_CACHE: dict[tuple[str, str | None, str | None], BaseClient] = {}
_CLIENT_CACHE_LOCK = threading.Lock()
_CLIENT_CACHE_MAX = 32


def invalidate_provider(provider_id: str) -> None:
    """Drop cached clients for one provider — called on provider update/delete.
    (The updated_at in the key already rotates on edit; this closes the sub-second
    window where two edits share a timestamp, and covers delete.)"""
    with _CLIENT_CACHE_LOCK:
        for key in [k for k in _CLIENT_CACHE if k[0] == provider_id]:
            _CLIENT_CACHE.pop(key, None)


def _resolve(ref: str | None) -> str | None:
    if not ref:
        return None
    # A malformed ref (corrupt row, a value that never went through make_ref)
    # makes parse_ref raise a bare ValueError that would bubble up as an opaque
    # 500. Translate it to the same clear, actionable CredentialResolutionError
    # the missing-value path raises, so the operator is told to re-enter the
    # credential rather than seeing a raw parse error.
    try:
        scope, name = keyring_store.parse_ref(ref)
    except ValueError as exc:
        raise CredentialResolutionError(
            "A stored credential reference for this provider is malformed and "
            "could not be parsed. Re-enter the credential(s) for this provider."
        ) from exc
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

    cache_key = (provider_id, addressing_style_override, cfg.updated_at)
    with _CLIENT_CACHE_LOCK:
        cached = _CLIENT_CACHE.get(cache_key)
    if cached is not None:
        return cached

    access_key = _resolve(cfg.access_key_ref)
    secret_key = _resolve(cfg.secret_key_ref)
    session_token = _resolve(cfg.session_token_ref)

    # A credential REF that's configured but whose vault value is missing (deleted
    # secret, out-of-sync vault) must fail loudly — not silently fall through to
    # anonymous below, which would issue unsigned calls under an identity the
    # operator thinks is configured and surface as a baffling AccessDenied. This is
    # distinct from the genuine no-credentials case (no ref at all → anonymous).
    # Only refs that would actually be USED count: a stale session-token ref on a
    # provider with no access/secret keys is dead config, not a broken credential —
    # the request would be anonymous either way, so it must not error.
    _missing = [
        label for label, ref, val in (
            ("access key", cfg.access_key_ref, access_key),
            ("secret key", cfg.secret_key_ref, secret_key),
        )
        if ref and val is None
    ]
    if (cfg.session_token_ref and session_token is None
            and access_key and secret_key):
        _missing.append("session token")
    if _missing:
        raise CredentialResolutionError(
            f"Provider '{cfg.name}' has {', '.join(_missing)} configured, but the "
            "value(s) could not be read from the secret vault. The vault may be out "
            "of sync — re-enter the credential(s) for this provider."
        )

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
    client = boto3.client(
        "s3",
        endpoint_url=cfg.endpoint_url or None,
        # botocore requires a region for SigV4; default for custom endpoints.
        region_name=cfg.region or "us-east-1",
        config=boto_config,
        **kwargs,
    )
    with _CLIENT_CACHE_LOCK:
        if len(_CLIENT_CACHE) >= _CLIENT_CACHE_MAX:
            # Evict the oldest entry (insertion order) — a rarely-used provider's
            # client simply gets rebuilt on next use.
            _CLIENT_CACHE.pop(next(iter(_CLIENT_CACHE)), None)
        _CLIENT_CACHE[cache_key] = client
    return client
