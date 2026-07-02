// Sidecar URL resolution (Phase 08).
//
// - Dev: VITE_SIDECAR_URL (if set) or the default localhost port.
// - Production (Tauri): the Rust side spawns the bundled sidecar on a free port
//   and exposes it via the `get_sidecar_url` command; we read it at startup.
// - Fallback: the dev default, so a plain browser/dev build still works.
//
// The resolved value is cached; call initSidecarBaseUrl() once at startup.

const DEV_DEFAULT = "http://127.0.0.1:8765";

let _baseUrl: string =
  (import.meta.env.VITE_SIDECAR_URL as string | undefined) || DEV_DEFAULT;

// Sidecar auth token (production/Tauri only). The Rust side generates a random
// token at launch, passes it to the sidecar via the STORAGE_AGENT_AUTH_TOKEN env
// var, and exposes it to the webview via the `get_sidecar_token` command. In
// dev/browser there is no Tauri and no token — the sidecar leaves auth open, so
// we simply send nothing.
let _token: string =
  (import.meta.env.VITE_SIDECAR_TOKEN as string | undefined) || "";

export const HEALTH_POLL_INTERVAL_MS = 5000;

/** Current resolved sidecar base URL (no trailing slash). */
export function sidecarBaseUrl(): string {
  return _baseUrl;
}

/** Current sidecar auth token ("" when running without one, e.g. dev/browser). */
export function sidecarToken(): string {
  return _token;
}

/** True when running inside the Tauri webview. */
function tauriInvoke(): ((cmd: string) => Promise<unknown>) | null {
  const g = globalThis as unknown as { __TAURI__?: { core?: { invoke?: (c: string) => Promise<unknown> } } };
  const invoke = g.__TAURI__?.core?.invoke;
  return typeof invoke === "function" ? invoke.bind(g.__TAURI__!.core) : null;
}

/**
 * Resolve the sidecar URL once at startup. Returns the resolved URL.
 * Never throws; falls back to the dev default on any error.
 */
export async function initSidecarBaseUrl(): Promise<string> {
  // Explicit dev override always wins.
  if (import.meta.env.VITE_SIDECAR_URL) {
    _baseUrl = import.meta.env.VITE_SIDECAR_URL as string;
    return _baseUrl;
  }
  const invoke = tauriInvoke();
  if (invoke) {
    try {
      const url = await invoke("get_sidecar_url");
      if (typeof url === "string" && url) {
        _baseUrl = url;
        // Best-effort: also resolve the auth token while we're talking to Rust.
        await initSidecarToken();
        return _baseUrl;
      }
    } catch {
      // fall through to default
    }
  }
  _baseUrl = DEV_DEFAULT;
  return _baseUrl;
}

/**
 * Resolve the sidecar auth token once at startup (Tauri only). Never throws;
 * leaves the token empty (dev/browser) on any error. Safe to call repeatedly.
 */
export async function initSidecarToken(): Promise<string> {
  if (import.meta.env.VITE_SIDECAR_TOKEN) {
    _token = import.meta.env.VITE_SIDECAR_TOKEN as string;
    return _token;
  }
  const invoke = tauriInvoke();
  if (invoke) {
    try {
      const token = await invoke("get_sidecar_token");
      if (typeof token === "string" && token) {
        _token = token;
        return _token;
      }
    } catch {
      // no token available — dev/browser or older shell; leave auth open
    }
  }
  return _token;
}
