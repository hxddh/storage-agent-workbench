import { useEffect } from "react";
import { tauriInvoke } from "../config";

/**
 * The one bridge between the Agent window and the OS shell (Tauri v2).
 *
 * Every entry point here is a real Rust-side capability in `src-tauri/src/lib.rs`
 * — a menu bar that emits `menu-command`, deep links that emit
 * `deep-link-request`, a global shortcut that emits `shortcut-event`, and the
 * `notify` / `set_window_title` / `open_app_folder` commands. In a plain
 * browser every call is a no-op that resolves false, so the product contract
 * (one Composer, one Task document) never depends on the shell being there.
 */

/** Commands the native menu bar dispatches. Mirrors `MENU_COMMANDS` in lib.rs. */
export const MENU_COMMANDS = [
  "settings",
  "new-task",
  "rename-task",
  "delete-task",
  "stop",
  "resume",
  "toggle-sidebar",
  "find",
  "review",
  "palette",
  "focus-composer",
  "theme",
  "shortcuts",
  "release-notes",
] as const;
export type MenuCommand = (typeof MENU_COMMANDS)[number];

export const DEEP_LINK_SCHEME = "storage-agent";
export const SUMMON_SHORTCUT = "CmdOrCtrl+Shift+S";

export function isNativeShell(): boolean {
  return tauriInvoke() !== null;
}

function tauriListen(event: string, handler: (payload: unknown) => void): (() => void) | null {
  const g = globalThis as unknown as {
    __TAURI__?: { event?: { listen?: (ev: string, cb: (e: { payload: unknown }) => void) => Promise<() => void> } };
  };
  const listen = g.__TAURI__?.event?.listen;
  if (typeof listen !== "function") return null;
  let unlisten: (() => void) | null = null;
  let disposed = false;
  listen(event, (e) => handler(e.payload))
    .then((fn) => { if (disposed) fn(); else unlisten = fn; })
    .catch(() => {});
  return () => { disposed = true; if (unlisten) unlisten(); };
}

/** `storage-agent://task/<id>` or `storage-agent://open?task=<id>` → the task id. */
export function taskIdFromDeepLink(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${DEEP_LINK_SCHEME}:`) return null;
  const path = `${parsed.host}${parsed.pathname}`.replace(/^\/+|\/+$/g, "");
  let id: string | null = null;
  if (path.startsWith("task/")) id = path.slice("task/".length);
  else if (path === "open" || path === "") id = parsed.searchParams.get("task");
  if (!id) return null;
  try { id = decodeURIComponent(id); } catch { return null; }
  return /^[A-Za-z0-9_-]{8,}$/.test(id) ? id : null;
}

function isMenuCommand(value: unknown): value is MenuCommand {
  return typeof value === "string" && (MENU_COMMANDS as readonly string[]).includes(value);
}

/**
 * Subscribe the window to the shell: menu commands, deep links (including the
 * URL the app was launched with, and argv forwarded by single-instance), and
 * the global summon shortcut. No-op in a browser.
 */
export function useNativeShell({ onOpenTask, onMenuCommand, onSummon }: {
  onOpenTask: (taskId: string) => void;
  onMenuCommand: (command: MenuCommand) => void;
  onSummon: () => void;
}) {
  useEffect(() => {
    const openUrls = (payload: unknown) => {
      const urls = Array.isArray(payload)
        ? payload
        : ((payload as { urls?: unknown })?.urls ?? []);
      for (const url of Array.isArray(urls) ? urls : []) {
        const id = typeof url === "string" ? taskIdFromDeepLink(url) : null;
        if (id) onOpenTask(id);
      }
    };
    const offs = [
      tauriListen("deep-link-request", openUrls),
      tauriListen("menu-command", (payload) => {
        const id = (payload as { id?: unknown })?.id ?? payload;
        if (isMenuCommand(id)) onMenuCommand(id);
      }),
      tauriListen("shortcut-event", () => onSummon()),
    ];
    // The URL the app was cold-started with (macOS hands it over after launch).
    const invoke = tauriInvoke();
    if (invoke) invoke("plugin:deep_link|get_current").then(openUrls).catch(() => {});
    return () => { for (const off of offs) off?.(); };
  }, [onOpenTask, onMenuCommand, onSummon]);
}

/** One OS notification. Resolves false in a browser or when the shell refuses. */
export async function notifyNative(title: string, body: string): Promise<boolean> {
  const invoke = tauriInvoke();
  if (!invoke) return false;
  try {
    await invoke("notify", { title, body });
    return true;
  } catch {
    return false;
  }
}

/** The OS window title (`<task> — Storage Agent`). No-op in a browser. */
export async function setNativeWindowTitle(title: string): Promise<void> {
  const invoke = tauriInvoke();
  if (!invoke) return;
  try { await invoke("set_window_title", { title }); } catch { /* cosmetic */ }
}

/** Reveal a folder under the app data directory: `skills`, or `data` (the
 * directory itself, where the AGENTS.md instructions file lives). Resolves
 * null in a browser or when the shell does not know the folder. */
export async function openNativeFolder(sub: "skills" | "data"): Promise<string | null> {
  const invoke = tauriInvoke();
  if (!invoke) return null;
  try {
    const path = await invoke("open_app_folder", { sub });
    return typeof path === "string" ? path : null;
  } catch {
    return null;
  }
}
