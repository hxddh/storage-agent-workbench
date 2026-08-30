import { sidecarBaseUrl, sidecarToken } from "./config";
import type {
  AccountProfile,
  EvidenceImport,
  EvidenceImportRunResult,
  ErrorInputKind,
  ExecutionMetrics,
  NextAction,
  SessionDetail,
  SessionMessage,
  SessionSummaryRow,
  ToolActivity,
  TriageCase,
  TurnResult,
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

// The blocking message fallback needs its own, more generous cap: the server
// WAITS up to 150 s for a still-streaming turn to finish before returning the
// persisted result (or a 409 "turn still in progress"). Give the client margin
// above that wait so it sees the server's answer, not its own timeout.
const TURN_FALLBACK_TIMEOUT_MS = 170_000;

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
// the turn falls back to the blocking POST rather than spinning indefinitely.
const STREAM_IDLE_TIMEOUT_MS = 120_000;

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

// Blocking turn (also the streaming fallback). The server waits for a
// same-turn_id stream still running server-side and returns the persisted
// result when it completes; on its 150 s wait timeout it returns HTTP 409
// "turn still in progress" — surfaced to callers as ApiError(status=409).
export const postSessionMessage = (id: string, content: string, turnId?: string) =>
  request<{ session_id: string; messages: SessionMessage[] } & TurnResult>(
    `/sessions/${id}/messages`,
    { method: "POST", body: JSON.stringify({ content, turn_id: turnId }) },
    TURN_FALLBACK_TIMEOUT_MS,
  );

/** Ask the server to cancel a running turn. Returns {status:"cancelling"}
 * while running or {status:"completed"} if the turn already finished; the
 * partial answer is persisted server-side with a stopped marker. */
export const cancelSessionTurn = (sessionId: string, turnId: string) =>
  request<{ status: string }>(`/sessions/${sessionId}/turns/${turnId}/cancel`, { method: "POST" });

// Streaming variant (SSE): invokes onDelta/onTool as the agent works and
// resolves on the `done` event. Throws on a non-OK response (e.g. 422 no model)
// or a stream `error` event — the caller should then fall back to
// postSessionMessage with the SAME turnId. The server dedups by turn_id, so the
// fallback never duplicates the turn or any inline run, even if the stream had
// already done work server-side before the connection broke.
export async function streamSessionMessage(
  id: string,
  content: string,
  on: { onDelta: (text: string) => void; onTool: (a: ToolActivity) => void },
  signal?: AbortSignal,
  turnId?: string,
): Promise<TurnResult> {
  // Idle watchdog: if no bytes arrive for STREAM_IDLE_TIMEOUT_MS, abort so the
  // caller falls back to the blocking POST instead of hanging forever. Chained
  // onto the caller's signal (the Stop button) so either can abort the stream.
  const localCtl = new AbortController();
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
  const res = await fetch(`${sidecarBaseUrl()}/sessions/${id}/messages/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ content, turn_id: turnId }),
    signal: localCtl.signal,
  });
  if (!res.ok || !res.body) {
    if (idleTimer) clearTimeout(idleTimer);
    let detail = `HTTP ${res.status}`;
    try {
      const b = await res.json();
      if (b?.detail) detail = typeof b.detail === "string" ? b.detail : JSON.stringify(b.detail);
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let result: TurnResult | null = null;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      kickIdle(); // reset the idle watchdog on every chunk received
      buf += dec.decode(value, { stream: true });
      const chunks = buf.split("\n\n");
      buf = chunks.pop() ?? "";
      for (const chunk of chunks) {
        const lines = chunk.split("\n");
        const type = lines.find((l) => l.startsWith("event:"))?.slice(6).trim();
        // Per the SSE spec an event's payload is ALL its data: lines joined
        // with newlines — not just the first one.
        const dataLines = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
        if (!type || dataLines.length === 0) continue;
        let data: any;
        try {
          data = JSON.parse(dataLines.join("\n"));
        } catch {
          continue; // skip a malformed frame instead of killing the stream
        }
        if (type === "delta") on.onDelta(data.text || "");
        else if (type === "tool") on.onTool(data as ToolActivity);
        else if (type === "done") {
          result = {
            proposed_actions: data.proposed_actions || [],
            evidence_used: data.evidence_used || [],
            evidence_gaps: data.evidence_gaps || [],
            skills_used: data.skills_used || [],
            skills_offered: data.skills_offered || [],
            message_id: data.message_id,
            stopped: data.stopped === true,
            metrics: data.metrics,
          };
        } else if (type === "error") throw new Error(data.detail || "stream error");
      }
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    // Release the connection on EVERY exit path (normal end, thrown error
    // event, malformed response, caller abort).
    try {
      await reader.cancel();
    } catch {
      /* already closed/aborted */
    }
  }
  // The stream closed without an explicit 'done'. The server may still have
  // persisted the turn — but we can't trust the partial result here. Throw so
  // the caller falls back to the blocking POST (idempotent via turn_id): it
  // returns the persisted result (incl. proposals) instead of leaving the user
  // with an empty next-steps list until they refresh.
  if (!result) throw new Error("stream ended without completion");
  return result;
}

export const attachRunToSession = (sessionId: string, runId: string) =>
  request<SessionDetail>(`/sessions/${sessionId}/runs/${runId}`, { method: "POST" });

// Next-action handoff (Phase 17): validate + prefill only; never executes.
export interface ActionPrepareResult {
  proposal: NextAction & { id: string };
  action_type: string;
  status: string;
  open: string | null;
  missing_inputs: string[];
  candidates: Record<string, Array<{ account_run_id: string; bucket_name: string }>>;
  prefill: Record<string, string>;
  safety_notes: string[];
}


export const prepareSessionAction = (id: string, proposal: NextAction) =>
  request<ActionPrepareResult>(`/sessions/${id}/actions/prepare`, {
    method: "POST",
    body: JSON.stringify({ proposal }),
  });

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

export interface TaskDecision {
  id: string;
  task_id: string;
  execution_id: string | null;
  work_result_id: string | null;
  action_type: string;
  title: string | null;
  reason: string | null;
  proposal: NextAction & { id?: string };
  status: "pending" | "approved" | "declined" | "superseded";
  resolution_note: string | null;
  created_at: string;
  resolved_at: string | null;
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
  created_at: string;
}

export interface TaskState {
  task_id: string;
  status: "ready" | "working" | "needs_decision" | "needs_attention" | "archived";
  active_execution: TaskExecution | null;
  last_event_seq: number;
  last_execution: TaskExecution | null;
  pending_decisions: TaskDecision[];
  context_version: number;
}

export const getTaskState = (taskId: string) =>
  request<TaskState>(`/agent-tasks/${taskId}/state`);

export const createTaskExecution = (taskId: string, direction: string, turnId?: string) =>
  request<{ execution: TaskExecution; created: boolean }>(
    `/agent-tasks/${taskId}/executions`,
    { method: "POST", body: JSON.stringify({ direction, turn_id: turnId }) },
  );

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

export const listTaskDecisions = (taskId: string, status?: string) =>
  request<{ task_id: string; decisions: TaskDecision[] }>(
    `/agent-tasks/${taskId}/decisions${status ? `?status_filter=${status}` : ""}`);

/** Resolve a first-class durable Decision. Approval returns the same
 * validate-and-prefill hand-over the action-prepare flow uses — nothing
 * auto-executes; the client opens the purpose-built confirmed flow. */
export const resolveTaskDecision = (
  taskId: string, decisionId: string, resolution: "approved" | "declined", note?: string,
) =>
  request<{ decision: TaskDecision; prepared: ActionPrepareResult | null }>(
    `/agent-tasks/${taskId}/decisions/${decisionId}/resolve`,
    { method: "POST", body: JSON.stringify({ resolution, note }) },
  );

export const listTaskArtifacts = (taskId: string) =>
  request<{ task_id: string; artifacts: TaskArtifact[] }>(`/agent-tasks/${taskId}/artifacts`);

/** Resolve the matching pending durable Decision for a confirmed proposal (so
 * the approval is recorded first-class), falling back to the legacy
 * validate-and-prefill endpoint when no durable decision gates this action. */
export async function approveDecisionOrPrepare(
  taskId: string, action: NextAction,
): Promise<ActionPrepareResult> {
  try {
    const { decisions } = await listTaskDecisions(taskId, "pending");
    const match = decisions.find((d) => d.action_type === action.action_type);
    if (match) {
      const resolved = await resolveTaskDecision(taskId, match.id, "approved");
      if (resolved.prepared) {
        return { ...resolved.prepared, proposal: { ...action, id: match.id } };
      }
    }
  } catch {
    /* fall back to the legacy prepare below */
  }
  return prepareSessionAction(taskId, action);
}

export interface ExecutionStreamResult {
  status: string;
  message_id?: string;
  work_result_id?: string;
  stopped: boolean;
  proposed_actions: NextAction[];
  metrics?: ExecutionMetrics;
  last_seq: number;
}

/** Follow one execution's durable structured event log as SSE.
 *
 * Every durable frame carries `id: <seq>`, so a broken connection resumes with
 * `after=<last seq>` and replays exactly what was missed — the stream is a
 * VIEW over durable rows, never the owner of the execution. Live answer text
 * arrives as transient `delta` frames. Resolves when the execution settles
 * (completed / waiting / cancelled); throws on `failed` / `interrupted`. */
export async function streamExecutionEvents(
  taskId: string,
  executionId: string,
  on: { onDelta: (text: string) => void; onTool: (a: ToolActivity) => void },
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
  const res = await fetch(
    `${sidecarBaseUrl()}/agent-tasks/${taskId}/executions/${executionId}/events?after=${after}`,
    { headers: { ...authHeaders() }, signal: localCtl.signal },
  );
  if (!res.ok || !res.body) {
    if (idleTimer) clearTimeout(idleTimer);
    let detail = `HTTP ${res.status}`;
    try {
      const b = await res.json();
      if (b?.detail) detail = typeof b.detail === "string" ? b.detail : JSON.stringify(b.detail);
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let lastSeq = after;
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
        if (idLine) lastSeq = Number(idLine) || lastSeq;
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
        else if (type === "execution.status") {
          const st = payload.status as string;
          if (st === "failed") throw new Error(payload.error || "the execution failed");
          if (st === "interrupted") throw new Error("the sidecar restarted while this execution was in flight");
          if ((st === "completed" || st === "waiting" || st === "cancelled") && payload.work_result_id) {
            result = {
              status: st,
              message_id: payload.message_id,
              work_result_id: payload.work_result_id,
              stopped: payload.stopped === true,
              proposed_actions: payload.proposed_actions || [],
              metrics: payload.metrics,
              last_seq: lastSeq,
            };
          } else if (st === "cancelled" && !result) {
            // Cancelled before it ever ran: no Work Result exists.
            result = { status: st, stopped: true, proposed_actions: [], last_seq: lastSeq };
          }
        }
        // Other structured events (queued/running/decision.*/context.*/end) are
        // progress the caller does not need individually here.
      }
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    try {
      await reader.cancel();
    } catch {
      /* already closed/aborted */
    }
  }
  if (!result) throw new Error("stream ended without completion");
  return result;
}

// --- Datasets ---
// Datasets are attached to a SESSION (the agent analyzes them as a tool). There
// is no run-scoped upload or dataset-list surface in the agent-native UI.

// Attach a data file to a SESSION (agent-native analysis). The in-chat agent
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

/** ONE tool call by the id its thread row carries (v0.56.0).
 *
 * This is what makes a trace row expandable in place: the reader opens the step
 * and sees the sanitized arguments it was called with and the output it
 * returned, instead of scrolling the whole-session inspector to a guessed time
 * window. Scoped to the session server-side. */
export const getSessionCall = (id: string, callId: string) =>
  request<SessionActivityItem>(`/sessions/${id}/activity/${encodeURIComponent(callId)}`);

export const getSessionAudit = (id: string, limit?: number, offset?: number) =>
  request<BoundedList<SessionAuditItem>>(
    `/sessions/${id}/audit?limit=${limit ?? 200}&offset=${offset ?? 0}`,
  );

export const getSessionOverview = (id: string) =>
  request<SessionOverview>(`/sessions/${id}/overview`);

/** Correct one of the agent's memory items. It replays its memory into every
 * later turn, so a wrong fact steers the rest of the investigation until fixed. */
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

/** One page of thread messages, oldest-first, ending just before `before`.
 * Omit `before` for the newest page. `has_more` reports whether older messages
 * exist above the page — the thread never silently hides history. */
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
