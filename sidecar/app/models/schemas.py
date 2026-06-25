"""Pydantic request/response models for provider APIs.

Input models accept plaintext secrets (``api_key``, ``access_key``,
``secret_key``, ``session_token``). These are written to the keyring and never
stored or echoed. Output models expose only ``*_ref`` references plus
``has_*`` booleans — never the secret value.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

CloudMode = Literal["readonly", "test-write"]


# --- Model providers --------------------------------------------------------


class ModelProviderCreate(BaseModel):
    name: str = Field(min_length=1)
    provider_type: str = Field(min_length=1)
    base_url: str | None = None
    model: str | None = None
    api_key: str | None = None  # plaintext on input only; stored in keyring


class ModelProviderUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1)
    provider_type: str | None = Field(default=None, min_length=1)
    base_url: str | None = None
    model: str | None = None
    # If provided (non-empty), the stored secret is rotated. Omit/null to keep.
    api_key: str | None = None


class ModelProviderOut(BaseModel):
    id: str
    name: str
    provider_type: str
    base_url: str | None
    model: str | None
    api_key_ref: str | None
    has_api_key: bool
    created_at: str
    updated_at: str


# --- Cloud providers --------------------------------------------------------


class CloudProviderCreate(BaseModel):
    name: str = Field(min_length=1)
    provider_type: str = Field(min_length=1)
    endpoint_url: str | None = None
    region: str | None = None
    addressing_style: str | None = "virtual"
    signature_version: str | None = "s3v4"
    access_key: str | None = None  # plaintext on input only; stored in keyring
    secret_key: str | None = None  # plaintext on input only; stored in keyring
    session_token: str | None = None  # plaintext on input only; stored in keyring
    mode: CloudMode = "readonly"
    allowed_buckets: list[str] = Field(default_factory=list)
    allowed_prefixes: list[str] = Field(default_factory=list)


class CloudProviderUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1)
    provider_type: str | None = Field(default=None, min_length=1)
    endpoint_url: str | None = None
    region: str | None = None
    addressing_style: str | None = None
    signature_version: str | None = None
    access_key: str | None = None
    secret_key: str | None = None
    session_token: str | None = None
    mode: CloudMode | None = None
    allowed_buckets: list[str] | None = None
    allowed_prefixes: list[str] | None = None


class CloudProviderOut(BaseModel):
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
    has_access_key: bool
    has_secret_key: bool
    has_session_token: bool
    mode: str
    allowed_buckets: list[str]
    allowed_prefixes: list[str]
    created_at: str
    updated_at: str


# --- Misc -------------------------------------------------------------------


class ModelProviderTestResult(BaseModel):
    ok: bool
    checks: dict[str, bool]
    detail: str


# --- S3 tool request bodies (Phase 03) --------------------------------------


class TestCredentialsRequest(BaseModel):
    provider_id: str = Field(min_length=1)


class HeadBucketRequest(BaseModel):
    provider_id: str = Field(min_length=1)
    bucket: str = Field(min_length=1)


class ListObjectsV2Request(BaseModel):
    provider_id: str = Field(min_length=1)
    bucket: str = Field(min_length=1)
    # Required by design; backend additionally clamps to a hard cap.
    max_keys: int = Field(ge=1)
    prefix: str | None = None


class HeadObjectRequest(BaseModel):
    provider_id: str = Field(min_length=1)
    bucket: str = Field(min_length=1)
    key: str = Field(min_length=1)


class TestRangeGetRequest(BaseModel):
    provider_id: str = Field(min_length=1)
    bucket: str = Field(min_length=1)
    key: str = Field(min_length=1)
    range_header: str = Field(min_length=1)


class PathStyleRequest(BaseModel):
    provider_id: str = Field(min_length=1)
    bucket: str = Field(min_length=1)


class InspectTlsRequest(BaseModel):
    endpoint_url: str = Field(min_length=1)
