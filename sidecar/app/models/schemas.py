"""Pydantic request/response models for provider APIs.

Input models accept plaintext secrets (``api_key``, ``access_key``,
``secret_key``, ``session_token``). These are written to the keyring and never
stored or echoed. Output models expose only ``*_ref`` references plus
``has_*`` booleans — never the secret value.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

CloudMode = Literal["readonly", "test-write"]


# --- Model providers --------------------------------------------------------


class ModelProviderCreate(BaseModel):
    name: str = Field(min_length=1)
    provider_type: str = Field(min_length=1)
    base_url: str | None = None
    model: str | None = None
    api_key: str | None = None  # plaintext on input only; stored in keyring
    # Optional explicit context window (tokens). Overrides the built-in table so
    # a newly-shipped large-context model isn't throttled to the default. Omit to
    # let the agent infer the window from the model name.
    context_window: int | None = Field(default=None, gt=0)
    # Optional explicit MAX OUTPUT tokens. Clamps the completion budget so a
    # third-party/unknown model whose real cap is below the default doesn't get a
    # max_tokens the endpoint 400s on. Omit to infer from the model name.
    max_output_tokens: int | None = Field(default=None, gt=0)


class ModelProviderUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1)
    provider_type: str | None = Field(default=None, min_length=1)
    base_url: str | None = None
    model: str | None = None
    # If provided (non-empty), the stored secret is rotated. Omit/null to keep.
    api_key: str | None = None
    # None = keep as-is; 0 = CLEAR back to NULL (infer from the model name);
    # positive = set. (None can't mean "clear" here — it's the "unchanged" sentinel.)
    context_window: int | None = Field(default=None, ge=0)
    max_output_tokens: int | None = Field(default=None, ge=0)  # None keep / 0 clear / +set


class ModelProviderOut(BaseModel):
    id: str
    name: str
    provider_type: str
    base_url: str | None
    model: str | None
    api_key_ref: str | None
    has_api_key: bool
    context_window: int | None = None
    max_output_tokens: int | None = None
    # True for the provider the agent actually uses. Selected explicitly via
    # POST /model-providers/{id}/activate; when none is selected the oldest
    # configured provider is the implicit default (matching the agent runtime).
    active: bool = False
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
    # True = key accepted (HTTP 200); False = key rejected (401/403); None = the
    # endpoint was reached but couldn't verify the key (no /models, e.g. a minimal
    # proxy). Lets the UI show "reachable but unverified" instead of a false green.
    api_key_verified: bool | None = None


# --- S3 tool request bodies --------------------------------------


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


# --- Analysis runs -----------------------------------------------

RunType = Literal[
    "diagnostic",
    "access_log_analysis",
    "inventory_analysis",
    "bucket_config_review",
    "account_discovery",
]


class RunCreate(BaseModel):
    run_type: RunType
    title: str | None = None
    provider_id: str | None = None
    bucket: str | None = None
    prefix: str | None = None
    user_prompt: str | None = None
    # account_discovery options (bounded; never trigger object scans).
    max_buckets: int | None = Field(default=None, ge=1, le=500)
    include_pattern: str | None = None
    exclude_pattern: str | None = None
    # Optional session this run belongs to.
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


# --- Datasets ----------------------------------------------------

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


class SessionDatasetUploadResponse(BaseModel):
    dataset_id: str
    session_id: str
    dataset_type: str
    filename: str
    status: str


# --- Account discovery -------------------------------------------


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


# --- Managed evidence import -------------------------------------

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


# --- Sessions ----------------------------------------------------

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
    pinned: bool | None = None


class SessionRunLink(BaseModel):
    run_id: str
    run_type: str
    role: str | None = None
    status: str
    title: str | None = None
    final_summary: str | None = None
    origin: str = "user"
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
    # Optional client-generated turn id. Lets the streaming endpoint and its
    # blocking fallback dedup the same turn (idempotency); see turn_guard.
    turn_id: str | None = None


class ActionRequest(BaseModel):
    """A next-action proposal to preview / prepare."""
    proposal: dict


# --- Error triage ------------------------------------------------

ErrorInputKind = Literal["error_code", "http_response", "sdk_stack_trace", "cli_output", "mixed"]


class ErrorTriageRequest(BaseModel):
    content: str = Field(min_length=1)
    input_kind: ErrorInputKind = "mixed"
    session_id: str | None = None
    provider_id: str | None = None
    bucket: str | None = None


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
    status: str = "parsed"
    candidate_causes: list[TriageFindingOut] = Field(default_factory=list)
    safe_next_actions: list[dict] = Field(default_factory=list)
    # Specialist StorageOps skill(s) covering the matched categories — a pointer
    # to the full method (derived from candidate_causes; not persisted).
    suggested_skills: list[str] = Field(default_factory=list)
    limitations: list[str] = Field(default_factory=list)
    created_at: str | None = None
    updated_at: str | None = None


class ToolActivityOut(BaseModel):
    """One line of a turn's tool trace, as `session_tools.note()` writes it.

    This was `dict[str, str]` while a trace row really was four strings. It then
    grew the fields that say what a call MEANT and what it COST — `args`
    (dict), `ok` (bool), `duration_ms` (int) — and pydantic v2 does not coerce
    those into `str`, so the response model raised and `GET /sessions/{id}`
    answered 500 for any session that had ever called a tool. The thread showed
    "Couldn't load this session"; the rail still listed it. Typing the row
    against its producer is what keeps the two from drifting apart again.

    `extra="allow"` is deliberate: a trace row is diagnostic output, and a field
    the writer adds must reach the reader rather than be silently dropped on the
    way out (`audit_error` — present only when a rule-17 audit write failed — is
    exactly such a field, and its PRESENCE is the signal).
    """

    model_config = {"extra": "allow"}

    tool: str = ""
    target: str = ""
    result: str = ""
    # The call's identity and its link to the persisted `tool_calls` row.
    # Absent on pre-v0.55.0 history, which must keep loading.
    id: str | None = None
    ok: bool | None = None
    # None means "not measured", which is not the same claim as 0 ms.
    duration_ms: int | None = None
    args: dict[str, Any] | None = None
    status: str | None = None


class SessionMessageOut(BaseModel):
    id: str
    role: str
    content: str | None
    referenced_run_ids: list[str] = Field(default_factory=list)
    referenced_evidence_ids: list[str] = Field(default_factory=list)
    tool_activity: list[ToolActivityOut] = Field(default_factory=list)
    # Persisted per-message transparency (migration 016): the grounding
    # ("why this answer") and the proposed next actions. These MUST be surfaced
    # on GET /sessions/{id} so a reloaded thread can re-render the chips/card —
    # without them pydantic would silently drop the columns the migration exists
    # to preserve.
    grounding: dict | None = None
    proposed_actions: list[dict] = Field(default_factory=list)
    created_at: str
    seq: int | None = None


class SessionSummary(BaseModel):
    model_config = {"extra": "ignore"}
    id: str
    title: str
    goal: str | None
    provider_id: str | None
    primary_bucket: str | None
    status: str
    pinned: bool = False
    run_count: int = 0
    finding_count: int = 0
    created_at: str
    updated_at: str


class SessionAgentMemoryOut(BaseModel):
    """One item of the agent's own working memory (v0.51.0).

    The agent writes these itself (``note_fact`` / ``record_finding`` /
    ``note_open_question``) and they are replayed into EVERY later turn's
    context. Before v0.51.0 they were persisted and fed to the model but never
    surfaced, so a wrong fact steered the rest of the investigation invisibly.
    Text is redacted on write (`sessions_repo.add_agent_memory`)."""

    id: str
    kind: str  # fact | finding | open_question
    text: str
    severity: str | None = None
    confidence: str | None = None
    source_run_id: str | None = None
    created_at: str | None = None


class SessionAttachedFileOut(BaseModel):
    """A file the user attached in this conversation, as the UI sees it.

    Filesystem paths are deliberately NOT included: the app data dir carries the
    OS username, and this shape is rendered in the thread and copied into
    exports."""

    id: str
    dataset_type: str
    source_filename: str | None = None
    detected_format: str | None = None
    row_count: int | None = None
    status: str | None = None
    created_at: str | None = None


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
    # The TAIL of the thread, not the whole thing (v0.47.0). `message_total` is
    # how many exist, so the client can offer "load earlier" instead of silently
    # showing a partial conversation as if it were complete.
    messages: list[SessionMessageOut] = Field(default_factory=list)
    message_total: int = 0
    # What the agent knows and holds (v0.51.0).
    agent_memory: list[SessionAgentMemoryOut] = Field(default_factory=list)
    attached_files: list[SessionAttachedFileOut] = Field(default_factory=list)
    # How many of those messages the agent actually replays into its context,
    # given the configured model's window. Below `message_total` means the
    # earliest turns have rolled out of its view and it is working from the
    # summary + agent_memory instead — which the UI must say rather than imply
    # the model still sees the whole conversation.
    context_messages: int = 0


class SessionMemoryUpdate(BaseModel):
    """Correct one memory item's text. The agent has `update_memory_item`; this
    is the same operation for the person watching, so a wrong fact can be fixed
    instead of steering every later turn."""

    text: str = Field(min_length=1, max_length=600)


class SessionMemoryResolve(BaseModel):
    """Close a memory item (answered question, fixed finding, stale fact)."""

    reason: str | None = Field(default=None, max_length=300)


class SessionTurnState(BaseModel):
    """Is a turn running for this session right now? (v0.51.0)

    Run state lives in the client's memory, so a reload during a turn used to
    show an idle session while the worker kept generating and spending. This is
    the server's answer to "is anything in flight", so the client can reattach."""

    running: bool = False
    turn_id: str | None = None
    started_at: str | None = None
    age_ms: int | None = None
