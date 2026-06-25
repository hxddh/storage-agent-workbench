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

export const HEALTH_POLL_INTERVAL_MS = 5000;

/** Current resolved sidecar base URL (no trailing slash). */
export function sidecarBaseUrl(): string {
  return _baseUrl;
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
        return _baseUrl;
      }
    } catch {
      // fall through to default
    }
  }
  _baseUrl = DEV_DEFAULT;
  return _baseUrl;
}
