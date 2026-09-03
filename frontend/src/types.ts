export interface ModelProvider {
  id: string;
  name: string;
  provider_type: string;
  base_url: string | null;
  model: string | null;
  api_key_ref: string | null;
  has_api_key: boolean;
  /** Optional explicit context window (tokens); overrides the built-in model table for the agent's depth budgets. */
  context_window: number | null;
  /** Optional explicit max output tokens; clamps the completion budget so a lower-cap endpoint doesn't 400. */
  max_output_tokens: number | null;
  /** Reasoning effort for reasoning-capable models (v1.10.0); null = the model's default. */
  reasoning_effort: ReasoningEffort | null;
  /** True when the configured model is known to accept an effort; the Composer paints the control only then. */
  reasoning_capable: boolean;
  /** True for the provider the agent uses (explicitly activated; otherwise the oldest is the implicit default). */
  active: boolean;
  created_at: string;
  updated_at: string;
}

export type ReasoningEffort = "low" | "medium" | "high";

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
  /** true=key accepted, false=key rejected, null=reached but key unverified. */
  api_key_verified?: boolean | null;
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
  prefill?: Record<string, unknown>;
}

// What the agent's answer is grounded in, and what it couldn't verify. Produced
// per turn by the skill contract; surfaced as a transparency affordance.
export interface Grounding {
  evidence_used: string[];
  evidence_gaps: string[];
  skills_used: string[];
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
  /** This call's identity (v0.55.0) — the SAME id as its persisted `tool_calls`
   * row. It resolves a "started" row to its completed record exactly (matching
   * on tool+target became ambiguous once v0.54.0 turned on parallel calls, where
   * two `get_bucket_config_detail` calls on ONE bucket differ only by `aspect`),
   * and it links a thread row to the real sanitized input/output behind it. */
  id?: string;
  tool: string;
  target: string;
  result: string;
  /** Did the call succeed? Computed in the sidecar from the tool result itself.
   * The UI used to infer this with /^(error|failed)\b/ against the result text,
   * which matched none of the real failure shapes this product produces
   * (`AccessDenied · req 8A9F2C1B`, `NoSuchBucket`, `SignatureDoesNotMatch`) —
   * so failed calls rendered as successes. Absent on pre-v0.55.0 history. */
  ok?: boolean;
  /** Measured wall-clock for this call. It has been written to `tool_calls`
   * since v0.45.0 and never sent to the client, so "which step was slow" was
   * answerable only in the database. */
  duration_ms?: number | null;
  /** The arguments that decide what this call MEANT — prefix, aspect, max_keys,
   * recursive, version_id … (v0.53.0). `target` carries bucket/key; without
   * these a `list_objects` over one prefix looked identical to a full listing. */
  args?: Record<string, string | number | boolean> | null;
  // Streaming only: a "started" record may arrive before the completed record
  // for the same call, so the UI can show an in-progress row that resolves in
  // place. Absent/other values mean the call is finished.
  status?: string;
  /** Set ONLY when the sidecar could not write this call's audit row (v0.59.0).
   * The call itself still ran and is still persisted; what is missing is its
   * audit_logs entry, which rule 17 requires. Absent on every healthy call, so
   * its presence — not its value — is the signal. A gap the reader cannot see
   * reads as "nothing happened", which is why it reaches the UI at all. */
  audit_error?: string | null;
  /** The inline approval this call raised (v1.11). Set on a gated call whose
   * execution paused for the user; the approval card renders at this row. */
  decision_id?: string | null;
  /** Wall-clock bounds of this call (v1.12). Durable rows may carry them from
   * the Sidecar; a live row is stamped by the client when its `tool.started`
   * / `tool.completed` frame arrives, so a "Worked for …" group can read the
   * span of its rows rather than a sum of their durations. */
  started_at?: string | null;
  finished_at?: string | null;
}

/** One step of the plan the model owns through `update_plan` (v1.12). */
export interface PlanStep {
  text: string;
  status: "pending" | "in_progress" | "completed";
}

/** One ordered transcript item recorded BEFORE the answer (v1.11). A `tool`
 * item references `tool_activity[].id`; pre-1.11 rows carry no items. */
export type TurnItemRef =
  | { kind: "message"; text: string }
  | { kind: "tool"; id: string }
  /** The latest plan, at the position of the first `update_plan` call (v1.12). */
  | { kind: "plan"; steps: PlanStep[] }
  /** The runtime compacted the replayed context before this point (v1.12). */
  | { kind: "compacted"; before_tokens: number | null; after_tokens: number | null };

export interface SessionMessage {
  id: string;
  role: string;
  content: string | null;
  referenced_run_ids: string[];
  referenced_evidence_ids: string[];
  tool_activity?: ToolActivity[];
  // Persisted per assistant turn (v0.21.0) so grounding + proposals survive a
  // reload; null/empty for user messages and pre-0.21.0 history.
  grounding?: Grounding | null;
  /** Ordered commentary / tool items before the answer (v1.11). */
  turn_items?: TurnItemRef[];
  /** Opaque paging cursor (v0.47.0); hand the oldest back as `before`. */
  seq?: number | null;
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
  /** The TAIL of the Task document (v0.47.0), not the whole history. */
  messages: SessionMessage[];
  /** How many messages exist in total, so the client can offer "load earlier". */
  message_total?: number;
  /** What the agent itself recorded and replays into every later turn (v0.51.0). */
  agent_memory?: AgentMemoryItem[];
  /** Files the user attached in this Task. */
  attached_files?: AttachedFile[];
  /** How many of `message_total` the agent actually replays into its context.
   * Below the total means the earliest turns have rolled out of its view. */
  context_messages?: number;
}

export type AgentMemoryKind = "fact" | "finding" | "open_question";

export interface AgentMemoryItem {
  id: string;
  kind: AgentMemoryKind;
  text: string;
  severity?: string | null;
  confidence?: string | null;
  source_run_id?: string | null;
  created_at?: string | null;
}

export interface AttachedFile {
  id: string;
  dataset_type: string;
  source_filename?: string | null;
  detected_format?: string | null;
  row_count?: number | null;
  status?: string | null;
  created_at?: string | null;
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
  run_id: string | null;
  input_kind: string;
  raw_input_redacted: string | null;
  parsed: Record<string, unknown>;
  summary: string;
  status: string;
  candidate_causes: TriageFinding[];
  safe_next_actions: NextAction[];
  limitations: string[];
  created_at: string | null;
  updated_at: string | null;
}

// --- session observability (v0.45.0) ----------------------------------------
// What a turn cost. Token fields are OPTIONAL on purpose: many OpenAI-compatible
// endpoints never report usage, and the UI must say so rather than show a zero.

export interface TokenUsage {
  requests?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  total_tokens?: number | null;
  /** Input the endpoint served from its prompt cache (v0.53.0). The fixed
   * prefix is re-sent on every step of a multi-step turn, so the hit rate — not
   * the raw input count — is what the turn costs. `null`/absent means the
   * endpoint did not report it, which is NOT the same as nothing cached. */
  cached_input_tokens?: number | null;
  /** Output tokens spent on reasoning — paid for, never displayed as text. */
  reasoning_tokens?: number | null;
  /** How many of the turn's `requests` model calls actually reported usage.
   * Present ONLY when some did and some did not, in which case the token counts
   * above are a FLOOR, not a total, and must be rendered as such. Absent means
   * either every call reported (the totals are complete) or none did (the
   * counts are null). */
  reported_requests?: number | null;
}

/** Live per-turn metrics from the SSE `done` event. */
export interface ExecutionMetrics extends TokenUsage {
  duration_ms?: number | null;
  tool_calls?: number | null;
  model?: string | null;
  usage?: TokenUsage;
  /** The per-turn TOKEN ceiling this turn ran under (v0.54.0). Not a provider
   * measurement — this Agent's per-execution governor, reported beside usage. */
  budget_tokens?: number | null;
  /** Which bound ended the Task, when one did: "tokens" | "chars". */
  budget_stopped_on?: string | null;
  /** Identical (tool, args) calls answered from Task memory instead of
   * being re-run. Absent when the turn repeated nothing. */
  repeat_calls_avoided?: number | null;
  /** The model's context window (v1.11), for a context meter. Null when the
   * runtime does not know it. */
  context_window?: number | null;
}

/** A persisted per-turn metrics row, keyed to the assistant message. */
export interface TurnMetricsRow extends TokenUsage {
  turn_id: string | null;
  message_id: string | null;
  model: string | null;
  /** The turn's own governor (v0.54.0), persisted so the footer still tells the
   * truth after a reload. NULL on turns recorded before it shipped. */
  budget_tokens?: number | null;
  repeat_calls_avoided?: number | null;
  duration_ms: number | null;
  tool_calls: number | null;
  created_at: string;
}

export interface SessionActivityItem {
  id: string;
  tool_name: string;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  status: string | null;
  duration_ms: number | null;
  created_at: string;
}

export interface SessionAuditItem {
  id: string;
  event_type: string;
  payload: Record<string, unknown> | null;
  run_id: string | null;
  created_at: string;
}

export interface BoundedList<T> {
  session_id: string;
  items: T[];
  total: number;
  offset: number;
  limit: number;
  /** True when more rows exist than were returned — never a silent cap. */
  truncated: boolean;
}

export interface SessionUsageRollup {
  /** False when NO turn reported tokens — render "unavailable", not zero. */
  available: boolean;
  turns: number;
  turns_measured: number;
  /** True when only some turns reported: the totals are a floor, not a total. */
  partial: boolean;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  requests: number;
  duration_ms: number;
}

export interface SessionOverview {
  session_id: string;
  tool_calls: number;
  tool_errors: number;
  tool_ms: number;
  audit_events: number;
  approvals: number;
  usage: SessionUsageRollup;
  turns: TurnMetricsRow[];
}
