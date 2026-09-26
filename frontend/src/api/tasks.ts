import { sidecarBaseUrl } from "../config";
import { ApiError, authHeaders, boundedController, errorDetail, request, UPLOAD_TIMEOUT_MS } from "./client";
import type {
  ErrorInputKind,
  TaskCallRecord,
  TaskRecord,
  TaskMessage,
  TaskOverview,
  TriageCase,
} from "../types";
import type { TaskProvenance } from "../viz/types";

/**
 * The Agent Task as a durable record: the task list, one task's document
 * (messages, findings, attached files), its message pages, its sanitized
 * activity/audit trail, its artifacts and provenance.
 *
 * Persistence still names a task a `session`; the product boundary adapts the
 * vocabulary here. Nothing in this module starts work — every write that
 * starts an execution lives in `runtime.ts`.
 */

// --- Task list and document ---

export interface TaskCreateInput {
  title: string;
  goal?: string;
  provider_id?: string;
  primary_bucket?: string;
}

export const createTask = (body: TaskCreateInput) =>
  request<TaskRecord>("/sessions", { method: "POST", body: JSON.stringify(body) });

export const getTaskRecord = (id: string) => request<TaskRecord>(`/sessions/${id}`);

// Task management: rename / pin / archive (PATCH), fork, delete.
export const updateTask = (
  id: string,
  body: { title?: string; status?: "active" | "archived"; pinned?: boolean },
) => request<TaskRecord>(`/sessions/${id}`, { method: "PATCH", body: JSON.stringify(body) });

export const deleteTask = (id: string) =>
  request<void>(`/sessions/${id}`, { method: "DELETE" });

/** v3.1 — the report is written in the reader's language (`en` | `zh`). */
export const getTaskReport = (id: string, lang?: string) =>
  request<{ session_id: string; format: string; content: string }>(
    `/sessions/${id}/report${lang ? `?lang=${encodeURIComponent(lang)}` : ""}`,
  );

/** One page of Task messages, oldest-first, ending just before `before`.
 * Omit `before` for the newest page. `has_more` reports whether older messages
 * exist above the page — the Task never silently hides history. */
export const getTaskMessages = (id: string, opts: { limit?: number; before?: number } = {}) => {
  const q = new URLSearchParams();
  if (opts.limit) q.set("limit", String(opts.limit));
  if (opts.before != null) q.set("before", String(opts.before));
  const suffix = q.toString() ? `?${q}` : "";
  return request<{
    session_id: string;
    messages: TaskMessage[];
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

export const getTaskTriage = (taskId: string) =>
  request<{ session_id: string; cases: TriageCase[] }>(`/sessions/${taskId}/error-triage`);

// --- Datasets ---
// A data file is attached to the TASK; the Agent then analyzes it as a tool
// and answers inline. There is no run-scoped upload surface.

export async function uploadTaskDataset(
  taskId: string,
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
    res = await fetch(`${sidecarBaseUrl()}/sessions/${taskId}/datasets/upload`, {
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

/** ONE tool call by the id its worked row carries (v0.56.0): the sanitized
 * arguments it was called with and the output it returned, opened in place.
 * Scoped to the task server-side. */
export const getTaskCall = (id: string, callId: string) =>
  request<TaskCallRecord>(`/sessions/${id}/activity/${encodeURIComponent(callId)}`);

export const getTaskOverview = (id: string) =>
  request<TaskOverview>(`/sessions/${id}/overview`);

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

export const listTaskArtifacts = (taskId: string) =>
  request<{ task_id: string; artifacts: TaskArtifact[] }>(`/agent-tasks/${taskId}/artifacts`);

/** Read-only provenance: findings, figures and analysis documents with their evidence chains. */
export const getTaskProvenance = (taskId: string) =>
  request<TaskProvenance>(`/agent-tasks/${taskId}/provenance`);

