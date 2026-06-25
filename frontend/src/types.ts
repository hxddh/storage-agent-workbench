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
  | "optimization_report";

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

// SSE event payloads (a subset, discriminated by `type`)
export type RunEvent =
  | { type: "agent_plan"; content: string }
  | { type: "tool_call_started"; tool_name: string; tool_call_id: string }
  | { type: "tool_call_finished"; tool_name: string; tool_call_id: string; status: string; output: Record<string, unknown> }
  | { type: "agent_message"; content: string }
  | { type: "finding"; severity: string; title: string; detail: string }
  | { type: "report_ready"; run_id: string; report_path: string }
  | { type: "error"; message: string };
