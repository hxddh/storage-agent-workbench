import { sidecarBaseUrl, sidecarToken } from "../config";
import { ApiError, UPLOAD_TIMEOUT_MS, authHeaders, errorDetail, request } from "./client";
import type { CloudProvider, FileRow, ModelProvider, ProbeResult, Settings, TaskHistory,
  TaskRow, TaskSnapshot, Watch,
} from "./types";

export { ApiError };

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

/** The Sidecar surface (v5). Every mutation of work goes through `/tasks`. */
export const api = {

  // tasks — the one submit path
  tasks: (q?: string) => request<{ tasks: TaskRow[] }>(`/tasks${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  task: (id: string) => request<TaskSnapshot>(`/tasks/${id}`),
  history: (id: string, before: string) =>
    request<TaskHistory>(`/tasks/${id}/history?before=${encodeURIComponent(before)}`),
  createTask: (direction?: string) =>
    request<TaskSnapshot>("/tasks", { method: "POST", ...json({ direction: direction || null }) }),
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
  upload: (id: string, file: File, opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {}): Promise<FileRow> =>
    new Promise((resolve, reject) => {
      const body = new FormData();
      body.append("file", file);
      body.append("dataset_type", "auto");
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${sidecarBaseUrl()}/tasks/${id}/files`);
      const token = authHeaders()["X-Sidecar-Token"];
      if (token) xhr.setRequestHeader("X-Sidecar-Token", token);
      xhr.timeout = UPLOAD_TIMEOUT_MS;
      xhr.upload.onprogress = (e) => { if (e.lengthComputable && e.total) opts.onProgress?.(e.loaded / e.total); };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText) as FileRow); }
          catch { reject(new ApiError(xhr.status, "The upload response was not valid.")); }
        } else {
          let detail = `HTTP ${xhr.status}`;
          try {
            const parsed = JSON.parse(xhr.responseText) as { detail?: unknown };
            if (typeof parsed.detail === "string") detail = parsed.detail;
            else if (parsed.detail) detail = JSON.stringify(parsed.detail);
          } catch { /* keep the status line */ }
          reject(new ApiError(xhr.status, detail));
        }
      };
      xhr.onerror = () => reject(new ApiError(0, "The local service is not reachable.", "offline"));
      xhr.ontimeout = () => reject(new ApiError(0, "The request timed out.", "timeout"));
      xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
      if (opts.signal) {
        if (opts.signal.aborted) { xhr.abort(); return; }
        opts.signal.addEventListener("abort", () => xhr.abort(), { once: true });
      }
      xhr.send(body);
    }),

  // the estate the Agent reads through its tools; Settings still configures the
  // per-connection watch, so only that one route is a client concern.
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
  health: () => request<{ status: string; version: string }>("/health", undefined, 5_000),
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
