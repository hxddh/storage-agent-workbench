import { sidecarBaseUrl, sidecarToken } from "../config";
import { ApiError, UPLOAD_TIMEOUT_MS, authHeaders, boundedController, errorDetail, request } from "./client";
import type {
  CloudProvider, Estate, FileRow, Issue, ModelProvider, ProbeResult, Settings, TaskRow, TaskSnapshot, Watch,
} from "./types";

export { ApiError };

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

/** The Sidecar surface (v5). Every mutation of work goes through `/tasks`. */
export const api = {
  health: () => request<{ status: string; version: string }>("/health", undefined, 5_000),

  // tasks — the one submit path
  tasks: (q?: string) => request<{ tasks: TaskRow[] }>(`/tasks${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  task: (id: string) => request<TaskSnapshot>(`/tasks/${id}`),
  createTask: (direction?: string, origin: "user" | "quick_ask" = "user") =>
    request<TaskSnapshot>("/tasks", { method: "POST", ...json({ direction: direction || null, origin }) }),
  renameTask: (id: string, title: string) => request<TaskRow>(`/tasks/${id}`, { method: "PATCH", ...json({ title }) }),
  deleteTask: (id: string) => request<void>(`/tasks/${id}`, { method: "DELETE" }),
  submit: (id: string, direction: string, opts: { parentTurnId?: string | null; attachments?: string[] } = {}) =>
    request<{ turn_id: string; status: string }>(`/tasks/${id}/turns`, {
      method: "POST",
      ...json({ direction, parent_turn_id: opts.parentTurnId ?? null, attachments: opts.attachments ?? [] }),
    }),
  steer: (id: string, text: string) =>
    request<{ steered: boolean; turn_id: string }>(`/tasks/${id}/steer`, { method: "POST", ...json({ text }) }),
  stop: (id: string) => request<{ stopping: boolean }>(`/tasks/${id}/stop`, { method: "POST" }),
  withdraw: (id: string, turnId: string) => request<{ cancelled: boolean }>(`/tasks/${id}/turns/${turnId}`, { method: "DELETE" }),
  resume: (id: string, turnId: string) =>
    request<{ turn_id: string }>(`/tasks/${id}/turns/${turnId}/resume`, { method: "POST" }),
  switchBranch: (id: string, turnId: string) =>
    request<TaskSnapshot>(`/tasks/${id}/head`, { method: "PUT", ...json({ turn_id: turnId }) }),
  report: async (id: string, lang: "en" | "zh") => {
    const res = await fetch(`${sidecarBaseUrl()}/tasks/${id}/report?lang=${lang}`, { headers: authHeaders() });
    if (!res.ok) throw new ApiError(res.status, await errorDetail(res));
    return res.text();
  },
  artifact: (id: string, artifactId: string) =>
    request<{ id: string; kind: string; title: string; payload: unknown }>(`/tasks/${id}/artifacts/${artifactId}`),
  upload: async (id: string, file: File): Promise<FileRow> => {
    const body = new FormData();
    body.append("file", file);
    body.append("dataset_type", "auto");
    const { controller, clear } = boundedController(UPLOAD_TIMEOUT_MS);
    try {
      const res = await fetch(`${sidecarBaseUrl()}/tasks/${id}/files`, {
        method: "POST", body, headers: authHeaders(), signal: controller.signal,
      });
      if (!res.ok) throw new ApiError(res.status, await errorDetail(res));
      return (await res.json()) as FileRow;
    } finally {
      clear();
    }
  },
  trace: (id: string) => request<{ spans: unknown[] }>(`/tasks/${id}/trace`),

  // the estate
  estate: (lang: string) => request<Estate>(`/estate?lang=${lang}`),
  issue: (id: string, lang: string) => request<Issue>(`/issues/${id}?lang=${lang}`),
  proposeFix: (id: string, lang: string) => request<Issue>(`/issues/${id}/fix?lang=${lang}`, { method: "POST" }),
  verifyIssue: (id: string, lang: string) =>
    request<{ result: string; issue: Issue }>(`/issues/${id}/verify?lang=${lang}`, { method: "POST" }),
  acceptIssue: (id: string, accepted: boolean, lang: string) =>
    request<Issue>(`/issues/${id}/accept?lang=${lang}`, { method: "POST", ...json({ accepted }) }),
  watch: (providerId: string) => request<Watch>(`/estate/watch/${providerId}`),
  setWatch: (providerId: string, enabled: boolean, intervalHours: number) =>
    request<Watch>(`/estate/watch/${providerId}`, { method: "PUT", ...json({ enabled, interval_hours: intervalHours }) }),
  runWatch: (providerId: string) => request<{ started: boolean }>(`/estate/watch/${providerId}/run`, { method: "POST" }),

  // providers
  models: () => request<ModelProvider[]>("/providers/models"),
  createModel: (body: Record<string, unknown>) => request<ModelProvider>("/providers/models", { method: "POST", ...json(body) }),
  updateModel: (id: string, body: Record<string, unknown>) =>
    request<ModelProvider>(`/providers/models/${id}`, { method: "PATCH", ...json(body) }),
  deleteModel: (id: string) => request<void>(`/providers/models/${id}`, { method: "DELETE" }),
  activateModel: (id: string) => request<ModelProvider>(`/providers/models/${id}/activate`, { method: "POST" }),
  testModel: (id: string) => request<ProbeResult>(`/providers/models/${id}/test`, { method: "POST" }, 15_000),
  clouds: () => request<CloudProvider[]>("/providers/clouds"),
  createCloud: (body: Record<string, unknown>) => request<CloudProvider>("/providers/clouds", { method: "POST", ...json(body) }),
  updateCloud: (id: string, body: Record<string, unknown>) =>
    request<CloudProvider>(`/providers/clouds/${id}`, { method: "PATCH", ...json(body) }),
  deleteCloud: (id: string) => request<void>(`/providers/clouds/${id}`, { method: "DELETE" }),
  testCloud: (id: string) =>
    request<{ success: boolean; error_code?: string; error_message_sanitized?: string }>(
      `/providers/clouds/${id}/test`, { method: "POST" }, 30_000),

  // settings
  settings: () => request<Settings>("/settings"),
  updateSettings: (body: Partial<Pick<Settings, "language" | "theme">>) =>
    request<Settings>("/settings", { method: "PATCH", ...json(body) }),
  skills: () => request<{ skills: Array<{ name: string; description: string; user: boolean }>; dirs: string[] }>("/skills"),
};

/** An EventSource URL (the header-less stream carries the token as a query param). */
export function streamUrl(path: string): string {
  const token = sidecarToken();
  const sep = path.includes("?") ? "&" : "?";
  return `${sidecarBaseUrl()}${path}${token ? `${sep}token=${encodeURIComponent(token)}` : ""}`;
}
