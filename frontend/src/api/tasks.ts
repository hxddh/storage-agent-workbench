import { sidecarBaseUrl } from "../config";
import { ApiError, authHeaders, boundedController, errorDetail, request, UPLOAD_TIMEOUT_MS } from "./client";
import type {
  BoundedList,
  ErrorInputKind,
  SessionActivityItem,
  SessionAuditItem,
  SessionDetail,
  SessionMessage,
  SessionOverview,
  SessionSummaryRow,
  TriageCase,
} from "../types";
import type { TaskProvenance } from "../viz/types";

/**
 * The Agent Task as a durable record: the task list, one task's document
 * (messages, findings, attached files), its message pages, its sanitized
 * activity/audit trail, its artifacts and provenance, and the engine outputs
 * (remediation plans, baselines, revisit schedule) the Artifacts panel lists.
 *
 * Persistence still names a task a `session`; the product boundary adapts the
 * vocabulary here. Nothing in this module starts work — every write that
 * starts an execution lives in `runtime.ts`.
 */

// --- Task list and document ---

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

// Task management: rename / pin / archive (PATCH), fork, delete.
export const patchSession = (
  id: string,
  body: { title?: string; status?: "active" | "archived"; pinned?: boolean },
) => request<SessionDetail>(`/sessions/${id}`, { method: "PATCH", body: JSON.stringify(body) });

/** Copy a task. With `fromMessageId`, BRANCH from that point instead of
 * copying all of it (v0.61.0): everything through that message comes along
 * and what followed does not. An unknown message id is a 404 rather than a
 * silent whole-task fork. */
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

// --- Error triage: deterministic parse + playbooks, offline ---

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

// --- Datasets ---
// A data file is attached to the TASK; the Agent then analyzes it as a tool
// and answers inline. There is no run-scoped upload surface.

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
  const { controller, clear } = boundedController(UPLOAD_TIMEOUT_MS, signal);
  let res: Response;
  try {
    res = await fetch(`${sidecarBaseUrl()}/sessions/${sessionId}/datasets/upload`, {
      method: "POST",
      headers: authHeaders(), // browser sets the multipart boundary; no secrets involved
      body: form,
      signal: controller.signal,
    });
  } finally {
    clear();
  }
  if (!res.ok) throw new ApiError(res.status, await errorDetail(res));
  return res.json();
}

// --- Task observability (rows sanitized on write) ---

export const getSessionActivity = (id: string, limit?: number, offset?: number) =>
  request<BoundedList<SessionActivityItem>>(
    `/sessions/${id}/activity?limit=${limit ?? 200}&offset=${offset ?? 0}`,
  );

/** ONE tool call by the id its worked row carries (v0.56.0): the sanitized
 * arguments it was called with and the output it returned, opened in place.
 * Scoped to the task server-side. */
export const getSessionCall = (id: string, callId: string) =>
  request<SessionActivityItem>(`/sessions/${id}/activity/${encodeURIComponent(callId)}`);

export const getSessionAudit = (id: string, limit?: number, offset?: number) =>
  request<BoundedList<SessionAuditItem>>(
    `/sessions/${id}/audit?limit=${limit ?? 200}&offset=${offset ?? 0}`,
  );

export const getSessionOverview = (id: string) =>
  request<SessionOverview>(`/sessions/${id}/overview`);

// --- Task memory ---

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

// --- Artifacts, provenance, engines ---

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

export const listTaskArtifacts = (taskId: string) =>
  request<{ task_id: string; artifacts: TaskArtifact[] }>(`/agent-tasks/${taskId}/artifacts`);

/** Read-only provenance: findings, figures and analysis documents with their evidence chains. */
export const getTaskProvenance = (taskId: string) =>
  request<TaskProvenance>(`/agent-tasks/${taskId}/provenance`);

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
