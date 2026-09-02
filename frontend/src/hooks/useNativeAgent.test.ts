import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { MENU_COMMANDS, notifyNative, setNativeWindowTitle, taskIdFromDeepLink, useNativeShell } from "./useNativeAgent";

type Listener = (event: { payload: unknown }) => void;

function installFakeTauri() {
  const listeners = new Map<string, Listener>();
  const invoke = vi.fn(async (cmd: string) => {
    if (cmd === "plugin:deep_link|get_current") return ["storage-agent://task/coldstart00"];
    return null;
  });
  (globalThis as unknown as { __TAURI__: unknown }).__TAURI__ = {
    core: { invoke },
    event: {
      listen: async (name: string, cb: Listener) => { listeners.set(name, cb); return () => listeners.delete(name); },
    },
  };
  return { listeners, invoke };
}

afterEach(() => {
  delete (globalThis as unknown as { __TAURI__?: unknown }).__TAURI__;
});

describe("the native shell bridge", () => {
  it("parses only well-formed storage-agent task links", () => {
    expect(taskIdFromDeepLink("storage-agent://task/0123456789abcdef")).toBe("0123456789abcdef");
    expect(taskIdFromDeepLink("storage-agent://open?task=abcdef01")).toBe("abcdef01");
    expect(taskIdFromDeepLink("storage-agent://task/short")).toBeNull();
    expect(taskIdFromDeepLink("https://example.com/task/0123456789")).toBeNull();
    expect(taskIdFromDeepLink("storage-agent://task/../../etc")).toBeNull();
    expect(taskIdFromDeepLink("not a url")).toBeNull();
  });

  it("is a no-op in a plain browser", async () => {
    const onOpenTask = vi.fn();
    const onMenuCommand = vi.fn();
    const onSummon = vi.fn();
    renderHook(() => useNativeShell({ onOpenTask, onMenuCommand, onSummon }));
    expect(await notifyNative("t", "b")).toBe(false);
    await setNativeWindowTitle("x");
    expect(onOpenTask).not.toHaveBeenCalled();
    expect(onMenuCommand).not.toHaveBeenCalled();
  });

  it("routes shell events to the window: menu ids, deep links, summon, and the cold-start URL", async () => {
    const { listeners, invoke } = installFakeTauri();
    const onOpenTask = vi.fn();
    const onMenuCommand = vi.fn();
    const onSummon = vi.fn();
    renderHook(() => useNativeShell({ onOpenTask, onMenuCommand, onSummon }));
    await Promise.resolve();
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledWith("plugin:deep_link|get_current");
    expect(onOpenTask).toHaveBeenCalledWith("coldstart00");

    listeners.get("menu-command")?.({ payload: { id: "toggle-sidebar" } });
    listeners.get("menu-command")?.({ payload: { id: "not-a-command" } });
    expect(onMenuCommand).toHaveBeenCalledTimes(1);
    expect(onMenuCommand).toHaveBeenCalledWith("toggle-sidebar");

    listeners.get("deep-link-request")?.({ payload: { urls: ["storage-agent://task/0123456789abcdef", "https://x"] } });
    expect(onOpenTask).toHaveBeenLastCalledWith("0123456789abcdef");

    listeners.get("shortcut-event")?.({ payload: { shortcut: "CmdOrCtrl+Shift+S" } });
    expect(onSummon).toHaveBeenCalledTimes(1);

    expect(await notifyNative("Task", "done")).toBe(true);
    expect(invoke).toHaveBeenCalledWith("notify", { title: "Task", body: "done" });
  });

  it("declares every menu command the Rust menu bar can send", () => {
    for (const id of ["settings", "new-task", "stop", "toggle-sidebar", "find", "review", "shortcuts"]) {
      expect(MENU_COMMANDS).toContain(id);
    }
  });
});
