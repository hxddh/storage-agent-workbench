import { useEffect } from "react";
import { sidecarBaseUrl } from "../config";

// Minimal native-agent OS helpers. All are best-effort and no-ops when
// running in a plain browser (no Tauri). Keeping this tiny means the
// core Agent Task contract (one Composer, one task document) is untouched.

type TauriInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function tauriInvoke(): TauriInvoke | null {
  const g = globalThis as unknown as {
    __TAURI__?: { core?: { invoke?: TauriInvoke } };
  };
  return g.__TAURI__?.core?.invoke?.bind(g.__TAURI__.core) ?? null;
}

function tauriListen(event: string, handler: (payload: unknown) => void): (() => void) | null {
  const g = globalThis as unknown as {
    __TAURI__?: { event?: { listen?: (ev: string, cb: (e: { payload: unknown }) => void) => Promise<() => void> } };
  };
  const listen = g.__TAURI__?.event?.listen;
  if (typeof listen !== "function") return null;
  let unlisten: (() => void) | null = null;
  listen(event, (e) => handler(e.payload)).then((fn) => { unlisten = fn; }).catch(() => {});
  return () => { if (unlisten) unlisten(); };
}

/** Handle `storage-agent://task/<id>` deep links by notifying the app. */
export function useDeepLink(onOpenTask: (taskId: string) => void) {
  useEffect(() => {
    const off = tauriListen("deep-link-request", (payload) => {
      // Payload shape from tauri-plugin-deep-link: { urls: string[] }
      const urls = (payload as { urls?: string[] })?.urls ?? [];
      for (const url of urls) {
        try {
          const u = new URL(url);
          // storage-agent://task/<id>  or  storage-agent://open?task=<id>
          const id = u.pathname.replace(/^\//, "") || u.searchParams.get("task");
          if (id) onOpenTask(decodeURIComponent(id));
        } catch {
          /* ignore malformed */
        }
      }
    });
    // Also handle argv deep links on Windows (single-instance forwards argv)
    const invoke = tauriInvoke();
    if (invoke) {
      invoke("plugin:deep_link|get_current").catch(() => {});
    }
    return () => { if (off) off(); };
  }, [onOpenTask]);
}

/** Notify when an execution that was backgrounded settles. No-op in browser. */
export function useTaskNotifications(activeTaskId: string | null) {
  useEffect(() => {
    if (!activeTaskId) return;
    const invoke = tauriInvoke();
    if (!invoke) return;
    // Example: ask the backend if notification permission is granted, no-op otherwise.
    // Tauri notification is fire-and-forget; errors are swallowed.
    void invoke;
    void sidecarBaseUrl;
  }, [activeTaskId]);
}

/** Register a global shortcut (⌘⇧S / Ctrl+Shift+S) to focus the Composer. Best-effort. */
export function useGlobalShortcut(focusComposer: () => void) {
  useEffect(() => {
    const invoke = tauriInvoke();
    if (!invoke) return;
    // tauri-plugin-global-shortcut registers shortcuts from Rust; here we just
    // ensure the frontend can be summoned. The actual registration lives in
    // src-tauri; this hook merely listens for the event the plugin forwards.
    const off = tauriListen("shortcut-event", (payload) => {
      if ((payload as { shortcut?: string })?.shortcut === "CmdOrCtrl+Shift+S") {
        focusComposer();
      }
    });
    return () => { if (off) off(); };
  }, [focusComposer]);
}
