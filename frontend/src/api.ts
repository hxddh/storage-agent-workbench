import { sidecarBaseUrl, sidecarToken } from "./config";
import type {
  AccountProfile,
  EvidenceImport,
  EvidenceImportRunResult,
  ErrorInputKind,
  ExecutionMetrics,
  SessionDetail,
  SessionMessage,
  SessionSummaryRow,
  ToolActivity,
  TriageCase,
  CloudProvider,
  CredentialsTestResult,
  HeadBucketResult,
  ListObjectsResult,
  ModelProvider,
  ModelProviderTestResult,
  ReportOut,
  RunDetail,
  BoundedList,
  SessionActivityItem,
  SessionAuditItem,
  SessionOverview,
  SessionTurnState,
} from "./types";

// Default client-side timeout for plain (non-streaming) requests. Guards against
// a sidecar that accepted the connection but never responds.
const REQUEST_TIMEOUT_MS = 120_000;


// Dataset uploads can be large local files; give them a long cap of their own
// (same AbortController chaining as request()).
const UPLOAD_TIMEOUT_MS = 300_000;

/** HTTP error carrying the response status so callers can branch on it (e.g.
 * 409 "turn still in progress" on the blocking fallback). */
export class ApiError extends Error {
  status: number;
  constructor(status: number, detail: string) {
    super(detail);
    this.name = "ApiError";
    this.status = status;
  }
}

// Abort a stream that has gone silent this long (no deltas/tools/heartbeat), so
// the client reconnects the durable event log at `after=<last seq>` rather than
// spinning indefinitely.
const STREAM_IDLE_TIMEOUT_MS = 120_000;
const STREAM_RECONNECT_MAX = 20;

/**
 * Auth header for the local sidecar. Empty in dev/browser (no Tauri token),
 * where the sidecar leaves auth open. See config.ts / the Tauri shell.
 */
export function authHeaders(): Record<string, string> {
  const token = sidecarToken();
  return token ? { "X-Sidecar-Token": token } : {};
}

/** Append the auth token as a query param (for SSE/EventSource, which can't set
 * headers). No-op when there is no token. */
export function withToken(url: string): string {
  const token = sidecarToken();
  if (!token) return url;
  return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

async function request<T>(path: string, init?: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  // Attach a timeout via AbortController, chaining any caller-supplied signal.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const external = init?.signal;
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", () => controller.abort(), { once: true });
  }
  let res: Response;
  try {
    res = await fetch(`${sidecarBaseUrl()}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...authHeaders(), ...(init?.headers ?? {}) },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.detail) detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// --- Model providers ---

export interface ModelProviderInput {
  name: string;
  provider_type: string;
  base_url?: string;
  model?: string;
  api_key?: string; // sent only when set/rotated; never persisted client-side
  /** Optional explicit context window (tokens). Overrides the built-in model
   * table so a new large-context model isn't throttled to the default. */
  context_window?: number | null;
  /** Optional explicit max output tokens. Clamps the completion budget so a
   * third-party/unknown model whose real cap is lower doesn't 400. */
  max_output_tokens?: number | null;
  /** Reasoning effort (v1.10.0). "" clears back to the model default on update. */
  reasoning_effort?: "low" | "medium" | "high" | "" | null;
}

export const listModelProviders = () =>
  request<ModelProvider[]>("/model-providers");

export const createModelProvider = (body: ModelProviderInput) =>
  request<ModelProvider>("/model-providers", {
    method: "POST",
    body: JSON.stringify(body),
  });

export const updateModelProvider = (id: string, body: Partial<ModelProviderInput>) =>
  request<ModelProvider>(`/model-providers/${id}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });

export const deleteModelProvider = (id: string) =>
  request<void>(`/model-providers/${id}`, { method: "DELETE" });

export const testModelProvider = (id: string) =>
  request<ModelProviderTestResult>(`/model-providers/${id}/test`, {
    method: "POST",
  });

/** Select which model provider the agent uses (with several configured). */
export const activateModelProvider = (id: string) =>
  request<ModelProvider>(`/model-providers/${id}/activate`, {
    method: "POST",
  });

// --- Cloud providers ---

export interface CloudProviderInput {
  name: string;
  provider_type: string;
  endpoint_url?: string;
  region?: string;
  addressing_style?: string;
  signature_version?: string;
  access_key?: string;
  secret_key?: string;
  session_token?: string;
  mode?: "readonly" | "test-write";
  allowed_buckets?: string[];
  allowed_prefixes?: string[];
}

export const listCloudProviders = () =>
  request<CloudProvider[]>("/cloud-providers");

export const createCloudProvider = (body: CloudProviderInput) =>
  request<CloudProvider>("/cloud-providers", {
    method: "POST",
    body: JSON.stringify(body),
  });

export const updateCloudProvider = (id: string, body: Partial<CloudProviderInput>) =>
  request<CloudProvider>(`/cloud-providers/${id}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });

export const deleteCloudProvider = (id: string) =>
  request<void>(`/cloud-providers/${id}`, { method: "DELETE" });

// --- Read-only S3 tools (Phase 03) ---

export const testCloudProvider = (id: string) =>
  request<CredentialsTestResult>(`/cloud-providers/${id}/test`, { method: "POST" });

export const toolHeadBucket = (provider_id: string, bucket: string) =>
  request<HeadBucketResult>("/tools/head-bucket", {
    method: "POST",
    body: JSON.stringify({ provider_id, bucket }),
  });

export const toolListObjectsV2 = (
  provider_id: string,
  bucket: string,
  max_keys: number,
  prefix?: string,
) =>
  request<ListObjectsResult>("/tools/list-objects-v2", {
    method: "POST",
    body: JSON.stringify({ provider_id, bucket, max_keys, prefix: prefix || undefined }),
  });

// --- Analysis runs ---
// Runs are created by the agent's own tools (server-side) or the evidence-import
// flow — never by the frontend. Only read endpoints are exposed here.

export const getRun = (id: string) => request<RunDetail>(`/runs/${id}`);

export const getReport = (runId: string) => request<ReportOut>(`/reports/${runId}`);

export const getAccountProfile = (runId: string) =>
  request<AccountProfile>(`/runs/${runId}/account-profile`);

// --- Managed evidence import (Phase 15) ---

export interface EvidenceImportPlanInput {
  account_run_id: string;
  bucket_name: string;
  source_type: "inventory" | "access_log";
  max_files?: number;
  max_bytes?: number;
  time_range_start?: string;
  time_range_end?: string;
}

export const planEvidenceImport = (body: EvidenceImportPlanInput) =>
  request<EvidenceImport>("/evidence-imports/plan", {
    method: "POST",
    body: JSON.stringify(body),
  });

export const getEvidenceImport = (id: string) =>
  request<EvidenceImport>(`/evidence-imports/${id}`);

export const confirmEvidenceImport = (id: string) =>
  request<EvidenceImport>(`/evidence-imports/${id}/confirm`, { method: "POST" });

export const runEvidenceImport = (id: string) =>
  request<EvidenceImportRunResult>(`/evidence-imports/${id}/run`, { method: "POST" });

// --- Sessions (Phase 16) ---

export interface SessionCreateInput {
  title: string;
  goal?: string;
  provider_id?: string;
  primary_bucket?: string;
}

export const listSessions = (q?: string) =>
  request<SessionSummaryRow[]>(`/sessions${q && q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`);

export const createSession = (body: SessionCreateInput) =>
  request<SessionDetail>("/sessions", { method: "POST", body: JSON.stringify(body) });

export const getSession = (id: string) => request<SessionDetail>(`/sessions/${id}`);

// Session management: rename / pin / archive (PATCH), fork, delete.
export const patchSession = (
  id: string,
  body: { title?: string; status?: "active" | "archived"; pinned?: boolean },
) => request<SessionDetail>(`/sessions/${id}`, { method: "PATCH", body: JSON.stringify(body) });

/** Copy a session. With `fromMessageId`, BRANCH from that point in the thread
 * instead of copying all of it (v0.61.0): everything through that message comes
 * along and what followed does not. An unknown message id is a 404 rather than a
 * silent whole-session fork. */
export const forkSession = (id: string, fromMessageId?: string) =>
  request<SessionDetail>(
    `/sessions/${id}/fork` +
      (fromMessageId ? `?from_message_id=${encodeURIComponent(fromMessageId)}` : ""),
    { method: "POST" },
  );

export const deleteSession = (id: string) =>
  request<void>(`/sessions/${id}`, { method: "DELETE" });

export const getSessionReport = (id: string) =>
  request<{ session_id: string; format: string; content: string }>(`/sessions/${id}/report`);

/** Ask the server to cancel a running turn. Returns {status:"cancelling"}
 * while running or {status:"completed"} if the turn already finished; the
 * partial answer is persisted server-side with a stopped marker. */
export const cancelSessionTurn = (sessionId: string, turnId: string) =>
  request<{ status: string }>(`/sessions/${sessionId}/turns/${turnId}/cancel`, { method: "POST" });

export const attachRunToSession = (sessionId: string, runId: string) =>
  request<SessionDetail>(`/sessions/${sessionId}/runs/${runId}`, { method: "POST" });

// Error triage (Phase 18): deterministic parse + playbooks (+ optional agent).
export interface ErrorTriageInput {
  content: string;
  input_kind: ErrorInputKind;
  session_id?: string;
  provider_id?: string;
  bucket?: string;
}

export const submitErrorTriage = (body: ErrorTriageInput) =>
  request<TriageCase>("/error-triage", { method: "POST", body: JSON.stringify(body) });

export const getSessionTriage = (sessionId: string) =>
  request<{ session_id: string; cases: TriageCase[] }>(`/sessions/${sessionId}/error-triage`);

// EventSource can't set headers, so the auth token rides as a query param
// (?token=…). The sidecar accepts the token there for SSE endpoints.
export const runEventsUrl = (id: string) => withToken(`${sidecarBaseUrl()}/runs/${id}/events`);

// --- Durable Agent Task runtime (v0.94) ---
// The Agent Task and its Executions are durable domain objects: submitting a
// Direction creates an execution row, progress is an append-only structured
// event log addressable by sequence number, and Decision / Work Result /
// Artifact are first-class rows. The client only OBSERVES executions — closing
// a stream, switching tasks, or reloading never interrupts one.

export interface TaskExecution {
  id: string;
  task_id: string;
  turn_id: string | null;
  direction: string | null;
  kind: string;
  status: "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted";
  error: string | null;
  resumed_from: string | null;
  steer_count: number;
  work_result_id: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface DecisionImpact {
  gate: "cloud_download" | "artifact_write" | "confirmation" | string;
  why: string | null;
  bucket: string | null;
  prefix: string | null;
  source_type: string | null;
  file_count: number | null;
  total_bytes: number | null;
  scan_scope: string | null;
  warnings?: string[];
}

export interface TaskDecision {
  id: string;
  task_id: string;
  execution_id: string | null;
  work_result_id: string | null;
  action_type: string;
  title: string | null;
  reason: string | null;
  /** `approval` (raised inline by a gated tool, v1.11) or a legacy `proposal`. */
  kind?: "approval" | "proposal";
  /** How the approval was granted: once, or for every later call in this task. */
  scope?: "once" | "task" | null;
  proposal?: Record<string, unknown> | null;
  status: "pending" | "approved" | "declined" | "superseded";
  resolution_note: string | null;
  created_at: string;
  resolved_at: string | null;
  impact?: DecisionImpact | null;
}

export interface TaskArtifact {
  id: string;
  task_id: string;
  execution_id: string | null;
  artifact_type: string;
  title: string | null;
  ref_kind: string | null;
  ref_id: string | null;
  format: string | null;
  summary: string | null;
  status?: string | null;
  payload?: Record<string, unknown> | null;
  created_at: string;
}

export type RemediationPlanStatus = "proposed" | "verified" | "partially_verified" | "stale";

export interface RemediationPlan {
  id: string;
  task_id: string;
  execution_id: string | null;
  version: number;
  status: RemediationPlanStatus;
  title: string | null;
  plan: Record<string, unknown>;
  simulation: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface TaskBaseline {
  id: string;
  task_id: string;
  execution_id: string | null;
  version: number;
  snapshot: Record<string, unknown>;
  context_version: number | null;
  created_at: string;
}

export interface RevisitSchedule {
  task_id: string;
  enabled: number | boolean;
  interval_days: number;
  next_due_at: string | null;
  last_revisit_at: string | null;
  last_catchup_note: string | null;
  created_at: string;
  updated_at: string;
}

export interface PriceTable {
  id: string;
  confirmed: boolean;
  example: boolean;
  note: string;
  rates: {
    currency?: string;
    gb_divisor?: number;
    storage_gb_month?: Record<string, number>;
    request_per_1k?: Record<string, number>;
    retrieval_gb?: Record<string, number>;
  };
  updated_at: string | null;
}

export interface TaskState {
  task_id: string;
  status: "ready" | "working" | "needs_decision" | "needs_attention" | "archived";
  active_execution: TaskExecution | null;
  last_event_seq: number;
  last_execution: TaskExecution | null;
  queued_executions: TaskExecution[];
  pending_decisions: TaskDecision[];
  context_version: number;
}

export const getTaskState = (taskId: string) =>
  request<TaskState>(`/agent-tasks/${taskId}/state`);

export const createTaskExecution = (
  taskId: string, direction: string, turnId?: string, kind?: "direction" | "verify" | "revisit",
) =>
  request<{ execution: TaskExecution; created: boolean }>(
    `/agent-tasks/${taskId}/executions`,
    { method: "POST", body: JSON.stringify({ direction, turn_id: turnId, ...(kind ? { kind } : {}) }) },
  );

/** Submit a Verify Execution through the one runtime submit path. */
export const verifyTaskPlan = (taskId: string) =>
  request<{ execution: TaskExecution; created: boolean }>(
    `/agent-tasks/${taskId}/verify`, { method: "POST" });

export const listRemediationPlans = (taskId: string) =>
  request<{ task_id: string; plans: RemediationPlan[] }>(`/agent-tasks/${taskId}/remediation-plans`);

export const listTaskBaselines = (taskId: string) =>
  request<{ task_id: string; baselines: TaskBaseline[] }>(`/agent-tasks/${taskId}/baselines`);

export const getTaskRevisit = (taskId: string) =>
  request<{ task_id: string; schedule: RevisitSchedule | null }>(`/agent-tasks/${taskId}/revisit`);

export const putTaskRevisit = (taskId: string, intervalDays: number, enabled: boolean) =>
  request<{ task_id: string; schedule: RevisitSchedule }>(
    `/agent-tasks/${taskId}/revisit`,
    { method: "PUT", body: JSON.stringify({ interval_days: intervalDays, enabled }) },
  );

export const getPriceTable = () => request<PriceTable>("/settings/price-table");

export const putPriceTable = (body: { confirmed?: boolean; rates?: PriceTable["rates"]; note?: string }) =>
  request<PriceTable>("/settings/price-table", { method: "PUT", body: JSON.stringify(body) });

/** Steer the CURRENT execution — the direction is injected into the running
 * model loop server-side. 409 (ApiError) when nothing is executing. */
export const steerTaskExecution = (taskId: string, text: string) =>
  request<{ status: string; execution: TaskExecution }>(
    `/agent-tasks/${taskId}/steer`,
    { method: "POST", body: JSON.stringify({ text }) },
  );

export const stopTaskExecution = (taskId: string, executionId: string) =>
  request<{ status: string; execution: TaskExecution }>(
    `/agent-tasks/${taskId}/executions/${executionId}/stop`, { method: "POST" });

export const resumeTaskExecution = (taskId: string, executionId: string) =>
  request<{ execution: TaskExecution; resumed_from: string }>(
    `/agent-tasks/${taskId}/executions/${executionId}/resume`, { method: "POST" });

export const listTaskExecutions = (taskId: string, limit = 50) =>
  request<{ task_id: string; executions: TaskExecution[] }>(
    `/agent-tasks/${taskId}/executions?limit=${limit}`);


export const listTaskDecisions = (taskId: string, status?: string) =>
  request<{ task_id: string; decisions: TaskDecision[] }>(
    `/agent-tasks/${taskId}/decisions${status ? `?status_filter=${status}` : ""}`);

/** Resolve an inline approval (or a legacy durable Decision). Approving wakes
 * the gated tool server-side and the SAME execution continues; `scope=task`
 * also allows later calls of the same action type in this task. */
export const resolveTaskDecision = (
  taskId: string, decisionId: string, resolution: "approved" | "declined",
  scope?: "once" | "task", note?: string,
) =>
  request<{ decision: TaskDecision; prepared: null }>(
    `/agent-tasks/${taskId}/decisions/${decisionId}/resolve`,
    { method: "POST", body: JSON.stringify({ resolution, note, ...(scope ? { scope } : {}) }) },
  );

export const listTaskArtifacts = (taskId: string) =>
  request<{ task_id: string; artifacts: TaskArtifact[] }>(`/agent-tasks/${taskId}/artifacts`);

export const getTaskProvenance = (taskId: string) =>
  request<import("./viz/types").TaskProvenance>(`/agent-tasks/${taskId}/provenance`);

export interface ExecutionStreamResult {
  status: string;
  message_id?: string;
  work_result_id?: string;
  stopped: boolean;
  metrics?: ExecutionMetrics;
  last_seq: number;
}

/** A closed assistant text segment (v1.11): commentary before an action
 * (`final=false`) or the answer (`final=true`). */
export interface MessageCompletedPayload {
  text: string;
  final: boolean;
  truncated?: boolean;
}

/** A gated tool paused the execution for the user's approval (v1.11). */
export interface ApprovalOpenedPayload {
  decision_id: string;
  action_type: string;
  title: string | null;
  reason: string | null;
  impact: DecisionImpact | null;
}

export interface DecisionResolvedPayload {
  decision_id: string;
  resolution: "approved" | "declined" | "superseded";
  action_type?: string;
  scope?: "once" | "task" | null;
}

export interface ExecutionStatusPayload {
  status: string;
  reason?: string;
  decision_id?: string;
  error?: string;
}

/** What a live follower can listen for on the durable event stream. */
export interface LiveEventHandlers {
  onDelta: (text: string) => void;
  onTool: (a: ToolActivity) => void;
  onSeq?: (seq: number) => void;
  onMessageCompleted?: (payload: MessageCompletedPayload) => void;
  onApprovalOpened?: (payload: ApprovalOpenedPayload) => void;
  onApprovalGranted?: (payload: { decision_id: string; action_type: string; title: string | null }) => void;
  onDecisionResolved?: (payload: DecisionResolvedPayload) => void;
  onStatus?: (payload: ExecutionStatusPayload) => void;
}

/** The durable event stream dropped before a terminal status. Reconnect with
 * `after=lastSeq` — never a blocking POST and never a message-id poll. */
export class StreamDisconnectedError extends Error {
  lastSeq: number;
  constructor(lastSeq: number, message = "stream disconnected") {
    super(message);
    this.name = "StreamDisconnectedError";
    this.lastSeq = lastSeq;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Follow one execution's durable structured event log as SSE.
 *
 * Every durable frame carries `id: <seq>`, so a broken connection resumes with
 * `after=<last seq>` and replays exactly what was missed — the stream is a
 * VIEW over durable rows, never the owner of the execution. Live answer text
 * arrives as transient `delta` frames. Resolves when the execution settles
 * (completed / waiting / cancelled); throws on `failed` / `interrupted`;
 * throws `StreamDisconnectedError` (with `lastSeq`) on idle timeout or a
 * dropped connection so the caller can reconnect. */
export async function streamExecutionEvents(
  taskId: string,
  executionId: string,
  on: LiveEventHandlers,
  opts: { signal?: AbortSignal; after?: number } = {},
): Promise<ExecutionStreamResult> {
  const localCtl = new AbortController();
  const { signal } = opts;
  if (signal) {
    if (signal.aborted) localCtl.abort();
    else signal.addEventListener("abort", () => localCtl.abort(), { once: true });
  }
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const kickIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => localCtl.abort(), STREAM_IDLE_TIMEOUT_MS);
  };
  kickIdle();
  const after = opts.after ?? 0;
  let lastSeq = after;
  const bumpSeq = (seq: number) => {
    lastSeq = seq;
    on.onSeq?.(seq);
  };
  try {
    const res = await fetch(
      `${sidecarBaseUrl()}/agent-tasks/${taskId}/executions/${executionId}/events?after=${after}`,
      { headers: { ...authHeaders() }, signal: localCtl.signal },
    );
    if (!res.ok || !res.body) {
      let detail = `HTTP ${res.status}`;
      try {
        const b = await res.json();
        if (b?.detail) detail = typeof b.detail === "string" ? b.detail : JSON.stringify(b.detail);
      } catch {
        /* ignore */
      }
      const err = new Error(detail) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let result: ExecutionStreamResult | null = null;
    const toolFromEvent = (payload: any, status: "started" | "completed"): ToolActivity => ({
      id: payload?.id,
      tool: payload?.tool ?? "",
      target: payload?.target ?? "",
      result: payload?.result ?? "",
      ok: payload?.ok,
      status,
    });
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        kickIdle();
        buf += dec.decode(value, { stream: true });
        const chunks = buf.split("\n\n");
        buf = chunks.pop() ?? "";
        for (const chunk of chunks) {
          const lines = chunk.split("\n");
          const type = lines.find((l) => l.startsWith("event:"))?.slice(6).trim();
          const idLine = lines.find((l) => l.startsWith("id:"))?.slice(3).trim();
          if (idLine) bumpSeq(Number(idLine) || lastSeq);
          const dataLines = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
          if (!type || dataLines.length === 0) continue;
          let data: any;
          try {
            data = JSON.parse(dataLines.join("\n"));
          } catch {
            continue;
          }
          const payload = data?.payload ?? {};
          if (type === "delta") on.onDelta(data.text || "");
          else if (type === "tool.started") on.onTool(toolFromEvent(payload, "started"));
          else if (type === "tool.completed") on.onTool(toolFromEvent(payload, "completed"));
          else if (type === "steer.applied")
            on.onTool({ tool: "user_steer", target: "", result: payload.text || "", ok: true, status: "completed" });
          else if (type === "message.completed")
            on.onMessageCompleted?.({ text: payload.text ?? "", final: payload.final === true, truncated: payload.truncated === true });
          else if (type === "approval.opened")
            on.onApprovalOpened?.({
              decision_id: payload.decision_id, action_type: payload.action_type ?? "",
              title: payload.title ?? null, reason: payload.reason ?? null, impact: payload.impact ?? null,
            });
          else if (type === "approval.granted")
            on.onApprovalGranted?.({ decision_id: payload.decision_id, action_type: payload.action_type ?? "", title: payload.title ?? null });
          else if (type === "decision.resolved")
            on.onDecisionResolved?.({
              decision_id: payload.decision_id, resolution: payload.resolution,
              action_type: payload.action_type, scope: payload.scope ?? null,
            });
          else if (type === "execution.status") {
            const st = payload.status as string;
            on.onStatus?.({ status: st, reason: payload.reason, decision_id: payload.decision_id, error: payload.error });
            if (st === "failed") throw new Error(payload.error || "the execution failed");
            if (st === "interrupted") throw new Error("the sidecar restarted while this execution was in flight");
            if ((st === "completed" || st === "waiting" || st === "cancelled") && payload.work_result_id) {
              result = {
                status: st,
                message_id: payload.message_id,
                work_result_id: payload.work_result_id,
                stopped: payload.stopped === true,
                metrics: payload.metrics,
                last_seq: lastSeq,
              };
            } else if (st === "cancelled" && !result) {
              result = { status: st, stopped: true, last_seq: lastSeq };
            }
          }
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* already closed/aborted */
      }
    }
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (!result) throw new StreamDisconnectedError(lastSeq, "stream ended without completion");
    return result;
  } catch (e) {
    if (signal?.aborted) throw e;
    if (e instanceof StreamDisconnectedError) throw e;
    const msg = String((e as Error)?.message ?? e);
    const status = (e as { status?: number }).status;
    // Terminal HTTP errors (missing execution, validation) are not reconnectable.
    if (status === 404 || status === 422 || status === 409) throw e;
    if (/the execution failed|sidecar restarted/i.test(msg)) throw e;
    throw new StreamDisconnectedError(lastSeq, msg);
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }
}

/** Reconnect a dropped durable event stream at `after=<last seq>` until the
 * execution settles or the caller aborts. This is the only recovery path —
 * there is no blocking POST fallback. */
export async function followExecutionEvents(
  taskId: string,
  executionId: string,
  on: LiveEventHandlers,
  opts: { signal?: AbortSignal; after?: number } = {},
): Promise<ExecutionStreamResult> {
  let after = opts.after ?? 0;
  let attempt = 0;
  while (!opts.signal?.aborted) {
    try {
      return await streamExecutionEvents(
        taskId, executionId,
        {
          ...on,
          onSeq: (seq) => {
            after = seq;
            on.onSeq?.(seq);
          },
        },
        { signal: opts.signal, after },
      );
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      if (!(e instanceof StreamDisconnectedError)) throw e;
      after = e.lastSeq;
      attempt += 1;
      if (attempt > STREAM_RECONNECT_MAX) throw e;
      await sleep(Math.min(8000, 250 * 2 ** Math.min(attempt, 5)));
    }
  }
  throw new DOMException("Aborted", "AbortError");
}

// --- Datasets ---
// Datasets are attached to a SESSION (the agent analyzes them as a tool). There
// is no run-scoped upload or dataset-list surface in the agent-native UI.

// Attach a data file to a SESSION (agent-native analysis). The Agent
// then analyzes it as a tool and answers inline — no deterministic analysis run.
export async function uploadSessionDataset(
  sessionId: string,
  file: File,
  datasetType: "access_log" | "inventory",
  signal?: AbortSignal,
): Promise<{ dataset_id: string; status: string }> {
  const form = new FormData();
  form.append("file", file);
  form.append("dataset_type", datasetType);
  // Same timeout/abort chaining as request(), with a longer cap for big files.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  let res: Response;
  try {
    res = await fetch(`${sidecarBaseUrl()}/sessions/${sessionId}/datasets/upload`, {
      method: "POST",
      headers: authHeaders(), // browser sets the multipart boundary; no secrets involved
      body: form,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const b = await res.json();
      if (b?.detail) detail = typeof b.detail === "string" ? b.detail : JSON.stringify(b.detail);
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, detail);
  }
  return res.json();
}

// --- Settings: secret-vault status ---

export interface VaultStatus {
  unreadable: boolean;
  backup_present: boolean;
}

export const getVaultStatus = () => request<VaultStatus>("/settings/secret-vault");


// --- session observability (v0.45.0) ----------------------------------------
// All three read from rows that were sanitized on write; nothing new is exposed
// here. What is new is that a session's own trail can finally be read back.

export const getSessionActivity = (id: string, limit?: number, offset?: number) =>
  request<BoundedList<SessionActivityItem>>(
    `/sessions/${id}/activity?limit=${limit ?? 200}&offset=${offset ?? 0}`,
  );

/** ONE tool call by the id its LiveTrace row carries (v0.56.0).
 *
 * This is what makes a trace row expandable in place: the reader opens the step
 * and sees the sanitized arguments it was called with and the output it
 * returned, instead of leaving the Task to hunt a guessed time window.
 * Scoped to the session server-side. */
export const getSessionCall = (id: string, callId: string) =>
  request<SessionActivityItem>(`/sessions/${id}/activity/${encodeURIComponent(callId)}`);

export const getSessionAudit = (id: string, limit?: number, offset?: number) =>
  request<BoundedList<SessionAuditItem>>(
    `/sessions/${id}/audit?limit=${limit ?? 200}&offset=${offset ?? 0}`,
  );

export const getSessionOverview = (id: string) =>
  request<SessionOverview>(`/sessions/${id}/overview`);

/** Correct one of the agent's memory items. It replays its memory into every
 * later turn, so a wrong fact steers the rest of the Task until fixed. */
export const correctSessionMemory = (id: string, memId: string, text: string) =>
  request<SessionDetail>(`/sessions/${id}/memory/${memId}`, {
    method: "PATCH",
    body: JSON.stringify({ text }),
  });

/** Close a memory item so it stops being replayed (resolved, not deleted). */
export const resolveSessionMemory = (id: string, memId: string, reason?: string) =>
  request<SessionDetail>(`/sessions/${id}/memory/${memId}/resolve`, {
    method: "POST",
    body: JSON.stringify({ reason: reason ?? null }),
  });

/** Server truth about whether a turn is in flight — the client's own run state
 * is in memory, so a reload mid-turn has nothing to go on. */
export const getSessionTurnState = (id: string) =>
  request<SessionTurnState>(`/sessions/${id}/turn`);

/** One page of Task messages, oldest-first, ending just before `before`.
 * Omit `before` for the newest page. `has_more` reports whether older messages
 * exist above the page — the Task never silently hides history. */
export const getSessionMessages = (id: string, opts: { limit?: number; before?: number } = {}) => {
  const q = new URLSearchParams();
  if (opts.limit) q.set("limit", String(opts.limit));
  if (opts.before != null) q.set("before", String(opts.before));
  const suffix = q.toString() ? `?${q}` : "";
  return request<{
    session_id: string;
    messages: SessionMessage[];
    total: number;
    has_more: boolean;
  }>(`/sessions/${id}/messages${suffix}`);
};

// --- Modern native-agent extensions (additive, bounded, same auth/redaction) ---
// Skills: bundled + user SKILL.md discovered from app-data/skills and
// STORAGE_AGENT_SKILLS_DIR. The Agent loads them on demand via read_skill.
export interface SkillMeta {
  name: string;
  description: string;
  maturity: string;
  mode: string;
  domains: string[];
  path: string;
}
export const listSkills = () => request<{ skills: SkillMeta[]; count: number }>("/skills");
export const getSkill = (name: string) =>
  request<{ name: string; description: string; body: string; truncated: boolean }>(`/skills/${encodeURIComponent(name)}`);
export const getSkillsDirs = () =>
  request<{ data_dir: string; dirs: { path: string; exists: boolean; skill_count: number }[]; env_override: string }>("/skills/_dirs/info");

// Observability: per-task OTel-inspired export (events, tool calls, metrics, artifacts)
export interface OtelExport {
  task_id: string;
  export: string;
  task?: { status: string; active_execution_id: string | null; context_version: number; updated_at: string };
  events?: { seq: number; execution_id: string; type: string; payload: string; at: string }[];
  events_truncated?: boolean;
  tool_calls?: { id: string; tool: string; status: string; duration_ms: number | null; at: string }[];
  turn_metrics?: { id: string; turn_id: string; model: string | null; input_tokens: number | null; output_tokens: number | null; total_tokens: number | null; duration_ms: number | null; tool_call_count: number | null }[];
  audit?: { id: string; event: string; at: string }[];
  artifacts?: { id: string; type: string; title: string | null; ref_kind: string | null; status: string | null; at: string }[];
}
export const getTaskOtelExport = (taskId: string, opts: { include_audit?: boolean; limit_events?: number } = {}) => {
  const q = new URLSearchParams();
  if (opts.include_audit) q.set("include_audit", "true");
  if (opts.limit_events) q.set("limit_events", String(opts.limit_events));
  const suffix = q.toString() ? `?${q}` : "";
  return request<OtelExport>(`/agent-tasks/${encodeURIComponent(taskId)}/export/otel${suffix}`);
};
export const getGlobalOtelExport = () =>
  request<{ export: string; tasks: { id: string; status: string; updated_at: string }[]; recent_executions: unknown[]; providers: unknown[]; active_provider_id: string | null }>("/observability/export");

// MCP bridge: opt-in read-only exposure (STORAGE_AGENT_ENABLE_MCP=1)
export interface McpStatus {
  enabled: boolean;
  allowed_tools: string[];
  note: string;
}
export const getMcpStatus = () => request<McpStatus>("/mcp/status");
export const listMcpTools = () => request<{ tools: { name: string; description: string; inputSchema: unknown }[]; count: number }>("/mcp/tools");
export const callMcpTool = (tool: string, args: Record<string, unknown>, provider_id?: string) =>
  request<{ tool: string; status: string; note: string; arguments_received: unknown; provider_id: string | null }>("/mcp/tools/call", {
    method: "POST",
    body: JSON.stringify({ tool, arguments: args, provider_id: provider_id ?? null }),
  });
