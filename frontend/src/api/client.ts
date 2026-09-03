import { sidecarBaseUrl, sidecarToken } from "../config";

/**
 * The one HTTP client under every Sidecar call: auth header, bounded
 * timeouts, and one error shape. Domain modules (`runtime`, `tasks`,
 * `settings`, `providers`) build on this; nothing else talks to `fetch`
 * except the SSE follower in `runtime.ts` and the multipart upload in
 * `tasks.ts`, which need the raw response.
 */

// Default client-side timeout for plain (non-streaming) requests. Guards against
// a sidecar that accepted the connection but never responds.
export const REQUEST_TIMEOUT_MS = 120_000;

// Dataset uploads can be large local files; give them a long cap of their own
// (same AbortController chaining as request()).
export const UPLOAD_TIMEOUT_MS = 300_000;

/** HTTP error carrying the response status so callers can branch on it (e.g.
 * 409 "no active execution to steer"). */
export class ApiError extends Error {
  status: number;
  constructor(status: number, detail: string) {
    super(detail);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * Auth header for the local sidecar. Empty in dev/browser (no Tauri token),
 * where the sidecar leaves auth open. See config.ts / the Tauri shell.
 */
export function authHeaders(): Record<string, string> {
  const token = sidecarToken();
  return token ? { "X-Sidecar-Token": token } : {};
}

/** Read the `detail` of a failed response, or a bare HTTP status line. */
export async function errorDetail(res: Response): Promise<string> {
  let detail = `HTTP ${res.status}`;
  try {
    const body = await res.json();
    if (body?.detail) detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
  } catch {
    /* ignore */
  }
  return detail;
}

/** Chain an optional caller signal onto a fresh controller with a timeout. */
export function boundedController(timeoutMs: number, external?: AbortSignal | null): { controller: AbortController; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return { controller, clear: () => clearTimeout(timer) };
}

export async function request<T>(path: string, init?: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  const { controller, clear } = boundedController(timeoutMs, init?.signal);
  let res: Response;
  try {
    res = await fetch(`${sidecarBaseUrl()}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...authHeaders(), ...(init?.headers ?? {}) },
      signal: controller.signal,
    });
  } finally {
    clear();
  }
  if (!res.ok) throw new ApiError(res.status, await errorDetail(res));
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
