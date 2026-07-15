import { sidecarBaseUrl, sidecarToken } from "./config";
import type {
  AccountProfile,
  EvidenceImport,
  EvidenceImportRunResult,
  ErrorInputKind,
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

export const forkSession = (id: string) =>
  request<SessionDetail>(`/sessions/${id}/fork`, { method: "POST" });

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
