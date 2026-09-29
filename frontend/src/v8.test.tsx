import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./composer/Composer";
import { ToastProvider } from "./components/Toast";
import { useNativeShell } from "./hooks/useNativeAgent";
import { I18nProvider } from "./i18n";
import { AppProvider } from "./shell/context";
import { initial, reduce } from "./store/task";
import { item, resetSeq, snapshot, turn } from "./test/fixtures";
import { ThemeProvider } from "./theme";

const models = [
  { id: "m1", name: "A", kind: "openai-compatible", base_url: null, model: "gpt-a", api_style: "chat", has_api_key: false,
    context_window: null, max_output_tokens: null, reasoning_effort: null, reasoning_capable: false, active: true },
  { id: "m2", name: "B", kind: "openai-compatible", base_url: null, model: "gpt-b", api_style: "chat", has_api_key: false,
    context_window: null, max_output_tokens: null, reasoning_effort: null, reasoning_capable: false, active: false },
];

let calls: string[] = [];
beforeEach(() => {
  resetSeq();
  calls = [];
  localStorage.setItem("saw.lang", "en");
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const body = url.includes("/providers/models") ? models : url.includes("/providers/clouds") ? [] : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
});

const wrap = (c: ReactNode) => (
  <ThemeProvider><I18nProvider><ToastProvider><AppProvider>{c}</AppProvider></ToastProvider></I18nProvider></ThemeProvider>
);

describe("v8 fixes", () => {
  it("choosing a model never sends the draft", async () => {
    await act(async () => { render(wrap(<Composer taskId="task-1" busy={false} />)); });
    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "half-written" } });
    await act(async () => { fireEvent.click(screen.getByTestId("model-chip")); });
    await act(async () => { fireEvent.click(screen.getByText("gpt-b")); });
    expect(calls.some((c) => c.startsWith("POST") && c.includes("/turns"))).toBe(false);
    expect(screen.getByTestId("composer-input")).toHaveValue("half-written");
  });

  it("the native shell subscribes once, however often the window re-renders", async () => {
    const invoke = vi.fn(async (_cmd: string) => [] as unknown);
    const listen = vi.fn(async () => () => {});
    (window as unknown as { __TAURI__: unknown }).__TAURI__ = { core: { invoke }, event: { listen } };
    function Probe({ n }: { n: number }) {
      useNativeShell({ onOpenTask: () => n, onMenuCommand: () => n, onSummon: () => n });
      return null;
    }
    const { rerender } = render(<Probe n={0} />);
    for (let n = 1; n < 5; n++) rerender(<Probe n={n} />);
    expect(invoke.mock.calls.filter((c) => c[0] === "plugin:deep_link|get_current")).toHaveLength(1);
    delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
  });

  it("a snapshot older than the stream does not bring back Working", () => {
    let m = reduce(initial("task-1"), { type: "snapshot", snapshot: snapshot([turn("t1", { status: "running" })], [
      item("t1", "user_message", { text: "go" })], { state: "working", running_turn_id: "t1" }) });
    const done = item("t1", "notice", { event: "completed" });
    m = reduce(m, { type: "item", item: done });
    m = reduce(m, { type: "state", state: { state: "ready", running_turn_id: null, queued_turn_ids: [], head_turn_id: "t1" } });
    // A reload answered by a snapshot built before `completed`:
    m = reduce(m, { type: "snapshot", snapshot: snapshot([turn("t1", { status: "running" })], [
      item("t1", "user_message", { text: "go" })], { state: "working", running_turn_id: "t1", last_seq: done.seq - 1 }) });
    expect(m.state).toBe("ready");
    expect(m.runningTurnId).toBeNull();
  });
});
