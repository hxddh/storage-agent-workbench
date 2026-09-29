/**
 * The Sidecar's shapes (v5). One stream is the truth: a Task is a tree of
 * Turns, and everything that happened in a Turn is an ordered list of Items.
 */

export type TaskState = "ready" | "working" | "queued" | "needs_attention";

export type TaskRow = {
  id: string;
  title: string;
  title_source: "seed" | "agent" | "user";
  origin: "user" | "watch" | "quick_ask";
  state: TaskState;
  created_at: string;
  updated_at: string;
};

export type TurnStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

export type Usage = {
  requests?: number;
  input_tokens?: number;
  output_tokens?: number;
  cached_tokens?: number;
  reasoning_tokens?: number;
};

export type Turn = {
  id: string;
  parent_turn_id: string | null;
  kind: "direction" | "resume" | "watch";
  direction: string;
  status: TurnStatus;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  resumed_from: string | null;
  usage: Usage | null;
};

export type Severity = "high" | "medium" | "low" | "info";
export type Finding = { title: string; severity: Severity; detail?: string };
export type Attachment = { dataset_id: string; filename: string; type: string };

type Base<T extends string, P> = {
  seq: number;
  id: string;
  task_id: string;
  turn_id: string | null;
  type: T;
  payload: P;
  created_at: string;
};

export type NoticeEvent =
  | "started" | "completed" | "failed" | "cancelled" | "interrupted" | "resumed" | "stopped"
  | "finalized" | "compacted" | "titled" | "imported";

export type Item =
  | Base<"user_message", { text: string; attachments?: Attachment[] }>
  | Base<"agent_message", { text: string }>
  | Base<"tool_call", { call_id: string; name: string; args: Record<string, unknown>; target: string }>
  | Base<"tool_progress", { call_id: string; name: string; done: number; total: number; unit: string }>
  | Base<"tool_output", {
      call_id: string; name: string; ok: boolean; refused?: boolean; summary: string;
      duration_ms?: number; detail?: string | null; detail_truncated?: boolean;
    }>
  | Base<"conclusion", { call_id: string; answer: string; findings: Finding[]; next_steps: string[] }>
  | Base<"steer", { text: string }>
  | Base<"compaction", { summary: string; turns_folded: number }>
  | Base<"notice", { event: NoticeEvent; error?: string; reason?: string; title?: string; note?: string; queued?: boolean }>
  | Base<"error", { message: string; action?: "settings" }>;

export type ItemType = Item["type"];
export type ItemOf<T extends ItemType> = Extract<Item, { type: T }>;

export type LiveSegment = { turn_id: string; segment_id: string; text: string };

export type FileRow = {
  id: string;
  origin: "upload" | "import";
  type: "access_log" | "inventory";
  filename: string;
  size_bytes: number;
  rows: number | null;
  status: "ready" | "analyzed" | "failed";
  bucket: string | null;
  created_at: string;
};

export type ArtifactRow = { id: string; kind: string; title: string; turn_id: string | null; provider_id: string | null; created_at: string };

export type TaskSnapshot = {
  task: TaskRow & { head_turn_id: string | null };
  state: TaskState;
  running_turn_id: string | null;
  queued: Array<{ turn_id: string; direction: string; created_at: string }>;
  turns: Turn[];
  items: Item[];
  forks: Record<string, string[]>;
  live: LiveSegment | null;
  files: FileRow[];
  artifacts: ArtifactRow[];
  last_seq: number;
};

export type StateEvent = { state: TaskState; running_turn_id: string | null; queued_turn_ids: string[] };
export type TaskFeedEvent = { task_id: string; state?: TaskState; title?: string; deleted?: boolean; created?: boolean };

// --- estate -------------------------------------------------------------------------

export type IssueStatus = "open" | "fix_proposed" | "resolved" | "recurred" | "accepted";

export type Fix = { kind: string; command: string; document?: Record<string, unknown>; notes?: string[] };

export type Issue = {
  id: string;
  provider_id: string;
  provider_name: string;
  bucket: string;
  code: string;
  title: string;
  severity: Severity;
  status: IssueStatus;
  detail: string | null;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  source_task_id: string | null;
  fix: Fix | null;
  fixable: boolean;
  last_verified_at: string | null;
  last_verify_result: string | null;
  events?: Array<{ kind: string; source: string | null; created_at: string }>;
};

export type Watch = {
  provider_id?: string;
  enabled: boolean;
  interval_hours: number;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_summary: string | null;
  last_task_id: string | null;
  running?: boolean;
};

export type EstateProvider = {
  provider_id: string;
  name: string;
  provider_type: string;
  bucket_count: number;
  last_checked_at: string | null;
  open_issues: { high: number; medium: number; low: number };
  watch: Watch;
};

export type Estate = {
  providers: EstateProvider[];
  bucket_count: number;
  issues: Issue[];
  open_issue_count: number;
  last_watch_at: string | null;
};

// --- providers & settings ----------------------------------------------------------

export type ModelKind =
  | "openai" | "anthropic" | "deepseek" | "openrouter" | "ollama" | "lmstudio" | "vllm" | "llamacpp"
  | "openai-compatible";

export type ModelProvider = {
  id: string;
  name: string;
  kind: ModelKind;
  base_url: string | null;
  model: string;
  api_style: "responses" | "chat";
  has_api_key: boolean;
  context_window: number | null;
  max_output_tokens: number | null;
  reasoning_effort: "low" | "medium" | "high" | null;
  reasoning_capable: boolean;
  active: boolean;
};

export type CloudProvider = {
  id: string;
  name: string;
  provider_type: string;
  endpoint_url: string | null;
  region: string | null;
  addressing_style: string | null;
  signature_version: string | null;
  allowed_buckets: string[];
  allowed_prefixes: string[];
  has_access_key: boolean;
  has_secret_key: boolean;
  has_session_token: boolean;
  watch?: Watch;
};

export type Settings = {
  language: "en" | "zh";
  theme: "system" | "light" | "dark";
  vault: { unreadable: boolean; backup_present: boolean };
  instructions: { loaded: boolean; path: string; chars: number; truncated: boolean; error: string | null };
};

export type ProbeResult = { ok: boolean; api_key_verified: boolean | null; detail: string };
