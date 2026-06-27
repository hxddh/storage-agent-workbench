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


class BucketConfigRequest(BaseModel):
    provider_id: str = Field(min_length=1)
    bucket: str = Field(min_length=1)


class PerformanceProfileRequest(BaseModel):
    provider_id: str = Field(min_length=1)
    bucket: str = Field(min_length=1)
    prefix: str | None = None


class InspectTlsRequest(BaseModel):
    endpoint_url: str = Field(min_length=1)


# --- Analysis runs (Phase 04) -----------------------------------------------

RunType = Literal[
    "diagnostic",
    "access_log_analysis",
    "inventory_analysis",
    "bucket_config_review",
    "account_discovery",
    "optimization_report",
]

PlannerMode = Literal["deterministic", "agent"]


class RunCreate(BaseModel):
    run_type: RunType
    title: str | None = None
    provider_id: str | None = None
    bucket: str | None = None
    prefix: str | None = None
    user_prompt: str | None = None
    planner_mode: PlannerMode = "deterministic"
    # account_discovery options (bounded; never trigger object scans).
    max_buckets: int | None = Field(default=None, ge=1, le=500)
    include_pattern: str | None = None
    exclude_pattern: str | None = None
    # Optional session this run belongs to (Phase 16).
    session_id: str | None = None


class RunCreated(BaseModel):
    run_id: str
    status: str
    title: str | None
    created_at: str


class RunSummary(BaseModel):
    id: str
    run_type: str
    title: str | None
    status: str
    planner_mode: str
    provider_id: str | None
    bucket: str | None
    final_summary: str | None
    created_at: str
    updated_at: str


class MessageOut(BaseModel):
    id: str
    role: str
    content: str | None
    created_at: str


class ToolCallOut(BaseModel):
    id: str
    tool_name: str
    input_json_sanitized: str | None
    output_json_sanitized: str | None
    status: str | None
    duration_ms: int | None
    created_at: str


class RunDetail(BaseModel):
    id: str
    run_type: str
    title: str | None
    status: str
    planner_mode: str
    provider_id: str | None
    bucket: str | None
    prefix: str | None = None
    user_prompt: str | None
    final_summary: str | None
    report_path: str | None
    session_id: str | None = None
    session_title: str | None = None
    created_at: str
    updated_at: str
    messages: list[MessageOut]
    tool_calls: list[ToolCallOut]


class MessageCreate(BaseModel):
    content: str = Field(min_length=1)


class ReportOut(BaseModel):
    run_id: str
    report_path: str
    format: str
    created_at: str
    content: str


# --- Datasets (Phase 05) ----------------------------------------------------

DatasetType = Literal["access_log", "inventory"]


class DatasetOut(BaseModel):
    id: str
    run_id: str | None
    dataset_type: str
    name: str | None
    source_filename: str | None
    stored_path: str | None
    duckdb_path: str | None
    table_name: str | None
    row_count: int | None
    status: str
    created_at: str


class DatasetUploadResponse(BaseModel):
    dataset_id: str
    run_id: str
    dataset_type: str
    filename: str
    status: str
    row_count: int | None = None


# --- Account discovery (Phase 14) -------------------------------------------


class EvidenceSourceOut(BaseModel):
    model_config = {"extra": "ignore"}
    source_type: str
    status: str
    configured: bool | None = None
    detail: dict = Field(default_factory=dict)


class AccountBucketOut(BaseModel):
    model_config = {"extra": "ignore"}
    bucket_name: str
    region: str | None = None
    access_status: str
    head_bucket_status: str | None = None
    versioning_status: str | None = None
    versioning_enabled: bool | None = None
    encryption_status: str | None = None
    lifecycle_status: str | None = None
    logging_status: str | None = None
    logging_enabled: bool | None = None
    inventory_status: str | None = None
    replication_status: str | None = None
    policy_status: str | None = None
    public_access_block_status: str | None = None
    tagging_status: str | None = None
    provider_unsupported_items: list[str] = Field(default_factory=list)
    access_denied_items: list[str] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)
    evidence_sources: list[EvidenceSourceOut] = Field(default_factory=list)


class AccountProfileOut(BaseModel):
    model_config = {"extra": "ignore"}
    run_id: str
    provider_id: str | None = None
    bucket_count: int = 0
    visible_count: int = 0
    processed_count: int = 0
    truncated: bool = False
    list_status: str = "error"
    summary: dict = Field(default_factory=dict)
    buckets: list[AccountBucketOut] = Field(default_factory=list)
    created_at: str | None = None


# --- Managed evidence import (Phase 15) -------------------------------------

EvidenceSourceType = Literal["inventory", "access_log"]


class EvidenceImportPlanRequest(BaseModel):
    account_run_id: str = Field(min_length=1)
    bucket_name: str = Field(min_length=1)
    source_type: EvidenceSourceType
    max_files: int | None = Field(default=None, ge=1, le=5000)
    max_bytes: int | None = Field(default=None, ge=1)
    # Required for access_log; ISO-8601 strings.
    time_range_start: str | None = None
    time_range_end: str | None = None


class EvidenceImportFileOut(BaseModel):
    object_key: str
    size_bytes: int
    kind: str
    selected: bool
    status: str


class EvidenceImportOut(BaseModel):
    model_config = {"extra": "ignore"}
    id: str
    provider_id: str | None = None
    account_run_id: str | None = None
    source_type: str
    source_bucket: str | None = None
    source_prefix: str | None = None
    evidence_ref: str | None = None
    format: str | None = None
    plan_source: str | None = None
    max_files: int = 0
    max_bytes: int = 0
    time_range_start: str | None = None
    time_range_end: str | None = None
    planned_file_count: int = 0
    planned_total_bytes: int = 0
    selected_file_count: int = 0
    selected_total_bytes: int = 0
    status: str = "planned"
    analysis_run_id: str | None = None
    warnings: list[str] = Field(default_factory=list)
    created_at: str | None = None
    confirmed_at: str | None = None
    files: list[EvidenceImportFileOut] = Field(default_factory=list)


class EvidenceImportRunResult(BaseModel):
    import_id: str
    status: str
    analysis_run_id: str | None = None
    downloaded_file_count: int = 0
    downloaded_total_bytes: int = 0


# --- Sessions (Phase 16) ----------------------------------------------------

SessionStatus = Literal["active", "archived"]


class SessionCreate(BaseModel):
    title: str = Field(min_length=1)
    goal: str | None = None
    provider_id: str | None = None
    primary_bucket: str | None = None


class SessionUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1)
    goal: str | None = None
    provider_id: str | None = None
    primary_bucket: str | None = None
    status: SessionStatus | None = None


class SessionRunLink(BaseModel):
    run_id: str
    run_type: str
    role: str | None = None
    status: str
    title: str | None = None
    final_summary: str | None = None
    created_at: str


class SessionFindingOut(BaseModel):
    model_config = {"extra": "ignore"}
    id: str
    source_run_id: str | None = None
    category: str | None = None
    severity: str | None = None
    confidence: str | None = None
    kind: str | None = None
    title: str | None = None
    interpretation: str | None = None
    status: str = "active"
    created_at: str | None = None


class NextAction(BaseModel):
    model_config = {"extra": "ignore"}
    title: str
    reason: str | None = None
    action_type: str
    requires_confirmation: bool = True
    confidence: str = "medium"
    source_run_ids: list[str] = Field(default_factory=list)


class SessionSummaryOut(BaseModel):
    model_config = {"extra": "ignore"}
    session_id: str
    summary_md: str = ""
    known_facts: list[dict] = Field(default_factory=list)
    open_questions: list[str] = Field(default_factory=list)
    next_actions: list[NextAction] = Field(default_factory=list)
    findings: list[dict] = Field(default_factory=list)
    limitations: list[str] = Field(default_factory=list)
    updated_at: str | None = None


class SessionMessageCreate(BaseModel):
    content: str = Field(min_length=1)


class ActionRequest(BaseModel):
    """A next-action proposal to preview / prepare (Phase 17)."""
    proposal: dict


# --- Error triage (Phase 18) ------------------------------------------------

ErrorInputKind = Literal["error_code", "http_response", "sdk_stack_trace", "cli_output", "mixed"]


class ErrorTriageRequest(BaseModel):
    content: str = Field(min_length=1)
    input_kind: ErrorInputKind = "mixed"
    session_id: str | None = None
    provider_id: str | None = None
    bucket: str | None = None
    planner_mode: PlannerMode = "deterministic"


class TriageFindingOut(BaseModel):
    model_config = {"extra": "ignore"}
    id: str | None = None
    category: str | None = None
    severity: str | None = None
    confidence: str | None = None
    title: str | None = None
    interpretation: str | None = None
    evidence: list[str] = Field(default_factory=list)
    next_checks: list[str] = Field(default_factory=list)
    source_refs: list[str] = Field(default_factory=list)


class TriageCaseOut(BaseModel):
    model_config = {"extra": "ignore"}
    id: str
    session_id: str | None = None
    provider_id: str | None = None
    bucket: str | None = None
    run_id: str | None = None
    input_kind: str
    raw_input_redacted: str | None = None
    parsed: dict = Field(default_factory=dict)
    summary: str = ""
    planner_mode: str = "deterministic"
    status: str = "parsed"
    candidate_causes: list[TriageFindingOut] = Field(default_factory=list)
    safe_next_actions: list[dict] = Field(default_factory=list)
    limitations: list[str] = Field(default_factory=list)
    agent_interpretation: str | None = None
    skills_offered: list[str] = Field(default_factory=list)
    skills_used: list[str] = Field(default_factory=list)
    evidence_used: list[str] = Field(default_factory=list)
    evidence_gaps: list[str] = Field(default_factory=list)
    created_at: str | None = None
    updated_at: str | None = None


class SessionMessageOut(BaseModel):
    id: str
    role: str
    content: str | None
    referenced_run_ids: list[str] = Field(default_factory=list)
    referenced_evidence_ids: list[str] = Field(default_factory=list)
    tool_activity: list[dict[str, str]] = Field(default_factory=list)
    created_at: str


class SessionSummary(BaseModel):
    id: str
    title: str
    goal: str | None
    provider_id: str | None
    primary_bucket: str | None
    status: str
    run_count: int = 0
    finding_count: int = 0
    created_at: str
    updated_at: str


class SessionDetail(BaseModel):
    id: str
    title: str
    goal: str | None
    provider_id: str | None
    primary_bucket: str | None
    status: str
    created_at: str
    updated_at: str
    runs: list[SessionRunLink] = Field(default_factory=list)
    findings: list[SessionFindingOut] = Field(default_factory=list)
    summary: SessionSummaryOut | None = None
    messages: list[SessionMessageOut] = Field(default_factory=list)
