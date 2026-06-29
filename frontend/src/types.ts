export interface ModelProvider {
  id: string;
  name: string;
  provider_type: string;
  base_url: string | null;
  model: string | null;
  api_key_ref: string | null;
  has_api_key: boolean;
  created_at: string;
  updated_at: string;
}

export type CloudMode = "readonly" | "test-write";

export interface CloudProvider {
  id: string;
  name: string;
  provider_type: string;
  endpoint_url: string | null;
  region: string | null;
  addressing_style: string | null;
  signature_version: string | null;
  access_key_ref: string | null;
  secret_key_ref: string | null;
  session_token_ref: string | null;
  has_access_key: boolean;
  has_secret_key: boolean;
  has_session_token: boolean;
  mode: CloudMode;
  allowed_buckets: string[];
  allowed_prefixes: string[];
  created_at: string;
  updated_at: string;
}

export interface ModelProviderTestResult {
  ok: boolean;
  checks: Record<string, boolean>;
  detail: string;
}

// --- S3 tool results (Phase 03) ---

export interface CredentialsTestResult {
  success: boolean;
  provider_type: string;
  endpoint_url: string | null;
  region: string | null;
  identity_hint: string | null;
  error_code: string | null;
  error_message_sanitized: string | null;
}

export interface HeadBucketResult {
  success: boolean;
  status_code: number | null;
  headers_sanitized: Record<string, string>;
  error_code: string | null;
  error_message_sanitized: string | null;
}

export interface ListObjectsResult {
  success: boolean;
  key_count: number;
  common_prefixes: string[];
  sample_keys: string[];
  is_truncated: boolean;
  error_code: string | null;
  error_message_sanitized: string | null;
}

// --- Analysis runs (Phase 04) ---

export type RunType =
  | "diagnostic"
  | "access_log_analysis"
  | "inventory_analysis"
  | "bucket_config_review"
  | "account_discovery"
  | "optimization_report";

export type PlannerMode = "deterministic" | "agent";

export interface RunSummary {
  id: string;
  run_type: string;
  title: string | null;
  status: string;
  provider_id: string | null;
  bucket: string | null;
  final_summary: string | null;
  created_at: string;
  updated_at: string;
}

export interface RunMessage {
  id: string;
  role: string;
  content: string | null;
  created_at: string;
}

export interface RunToolCall {
  id: string;
  tool_name: string;
  input_json_sanitized: string | null;
  output_json_sanitized: string | null;
  status: string | null;
  duration_ms: number | null;
  created_at: string;
}

export interface RunDetail {
  id: string;
  run_type: string;
  title: string | null;
  status: string;
  provider_id: string | null;
  bucket: string | null;
  prefix: string | null;
  user_prompt: string | null;
  final_summary: string | null;
  report_path: string | null;
  created_at: string;
  updated_at: string;
  messages: RunMessage[];
  tool_calls: RunToolCall[];
}

export interface ReportOut {
  run_id: string;
  report_path: string;
  format: string;
  created_at: string;
  content: string;
}

export interface Dataset {
  id: string;
  run_id: string | null;
  dataset_type: string;
  name: string | null;
  source_filename: string | null;
  stored_path: string | null;
  duckdb_path: string | null;
  table_name: string | null;
  row_count: number | null;
  status: string;
  created_at: string;
}

// SSE event payloads (a subset, discriminated by `type`)
export type RunEvent =
  | { type: "plan"; content: string }
  | { type: "tool_call_started"; tool_name: string; tool_call_id: string }
  | { type: "tool_call_finished"; tool_name: string; tool_call_id: string; status: string; output: Record<string, unknown> }
  | { type: "summary"; content: string }
  | { type: "finding"; severity: string; title: string; detail: string }
  | { type: "report_ready"; run_id: string; report_path: string }
  | { type: "error"; message: string }
  // Run lifecycle events (shared by deterministic and agent-planner runs)
  | { type: "run_started" }
  | { type: "tool_selected"; tool_name: string; reason: string }
  | { type: "guardrail_passed"; name: string }
  | { type: "guardrail_blocked"; name: string; message: string }
  | { type: "final_summary"; content: string };

// --- Account discovery (Phase 14) ---

export interface EvidenceSource {
  source_type: string;
  status: string;
  configured: boolean | null;
  detail: Record<string, unknown>;
}

export interface AccountBucket {
  bucket_name: string;
  region: string | null;
  access_status: string;
  head_bucket_status: string | null;
  versioning_status: string | null;
  versioning_enabled: boolean | null;
  encryption_status: string | null;
  lifecycle_status: string | null;
  logging_status: string | null;
  logging_enabled: boolean | null;
  inventory_status: string | null;
  replication_status: string | null;
  policy_status: string | null;
  public_access_block_status: string | null;
  tagging_status: string | null;
  provider_unsupported_items: string[];
  access_denied_items: string[];
  errors: string[];
  evidence_sources: EvidenceSource[];
}

export interface AccountProfile {
  run_id: string;
  provider_id: string | null;
  bucket_count: number;
  visible_count: number;
  processed_count: number;
  truncated: boolean;
  list_status: string;
  summary: Record<string, unknown>;
  buckets: AccountBucket[];
  created_at: string | null;
}

// --- Managed evidence import (Phase 15) ---

export interface EvidenceImportFile {
  object_key: string;
  size_bytes: number;
  kind: string;
  selected: boolean;
  status: string;
}

export interface EvidenceImport {
  id: string;
  provider_id: string | null;
  account_run_id: string | null;
  source_type: string;
  source_bucket: string | null;
  source_prefix: string | null;
  evidence_ref: string | null;
  format: string | null;
  plan_source: string | null;
  max_files: number;
  max_bytes: number;
  time_range_start: string | null;
  time_range_end: string | null;
  planned_file_count: number;
  planned_total_bytes: number;
  selected_file_count: number;
  selected_total_bytes: number;
  status: string;
  analysis_run_id: string | null;
  warnings: string[];
  created_at: string | null;
  confirmed_at: string | null;
  files: EvidenceImportFile[];
}

export interface EvidenceImportRunResult {
  import_id: string;
  status: string;
  analysis_run_id: string | null;
  downloaded_file_count: number;
  downloaded_total_bytes: number;
}

// --- Sessions (Phase 16) ---

export interface SessionSummaryRow {
  id: string;
  title: string;
  goal: string | null;
  provider_id: string | null;
  primary_bucket: string | null;
  status: string;
  pinned?: boolean;
  run_count: number;
  finding_count: number;
  created_at: string;
  updated_at: string;
}

export interface SessionRunLink {
  run_id: string;
  run_type: string;
  role: string | null;
  status: string;
  title: string | null;
  final_summary: string | null;
  // 'agent' = the agent's own read-only survey/review (internal compute — not
  // shown as a structured run card; the agent narrates it). 'user' = an explicit
  // auditable report the user asked for.
  origin: string;
  created_at: string;
}

export interface SessionFinding {
  id: string;
  source_run_id: string | null;
  category: string | null;
  severity: string | null;
  confidence: string | null;
  kind: string | null;
  title: string | null;
  interpretation: string | null;
  status: string;
  created_at: string | null;
}

export interface NextAction {
  title: string;
  reason: string | null;
  action_type: string;
  requires_confirmation: boolean;
  confidence: string;
  source_run_ids: string[];
}

export interface SessionSummaryData {
  session_id: string;
  summary_md: string;
  known_facts: Array<Record<string, unknown>>;
  open_questions: string[];
  next_actions: NextAction[];
  findings: Array<Record<string, unknown>>;
  limitations: string[];
  updated_at: string | null;
}

export interface ToolActivity {
  tool: string;
  target: string;
  result: string;
}

export interface SessionMessage {
  id: string;
  role: string;
  content: string | null;
  referenced_run_ids: string[];
  referenced_evidence_ids: string[];
  tool_activity?: ToolActivity[];
  created_at: string;
}

export interface SessionDetail {
  id: string;
  title: string;
  goal: string | null;
  provider_id: string | null;
  primary_bucket: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  runs: SessionRunLink[];
  findings: SessionFinding[];
  summary: SessionSummaryData | null;
  messages: SessionMessage[];
}

// --- Error triage (Phase 18) ---

export type ErrorInputKind = "error_code" | "http_response" | "sdk_stack_trace" | "cli_output" | "mixed";

export interface TriageFinding {
  id?: string | null;
  category: string | null;
  severity: string | null;
  confidence: string | null;
  title: string | null;
  interpretation: string | null;
  evidence: string[];
  next_checks: string[];
  source_refs: string[];
}

export interface TriageCase {
  id: string;
  session_id: string | null;
  provider_id: string | null;
  bucket: string | null;
  input_kind: string;
  raw_input_redacted: string | null;
  parsed: Record<string, unknown>;
  summary: string;
  planner_mode: string;
  status: string;
  candidate_causes: TriageFinding[];
  safe_next_actions: NextAction[];
  agent_interpretation: string | null;
  skills_offered: string[];
  skills_used: string[];
  evidence_used: string[];
  evidence_gaps: string[];
  limitations: string[];
  created_at: string | null;
  updated_at: string | null;
}
