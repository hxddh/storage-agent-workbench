import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "./components/Toast";
import { formatDuration } from "./hooks/useElapsed";
import { I18nProvider } from "./i18n";
import { Settings } from "./settings/Settings";
import { AppProvider, useApp } from "./shell/context";
import { initial, reduce } from "./store/task";
import { TaskPage } from "./task/TaskPage";
import { item, resetSeq, snapshot, turn } from "./test/fixtures";
import { ThemeProvider } from "./theme";

type Route = (url: string, init?: RequestInit) => unknown;

function serve(route: Route) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = route(url, init) ?? {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
}

function wrap(children: ReactNode) {
  return <ThemeProvider><I18nProvider><ToastProvider><AppProvider>{children}</AppProvider></ToastProvider></I18nProvider></ThemeProvider>;
}

function OpenSettings({ section }: { section: string }) {
  const app = useApp();
  useEffect(() => { app.openSettings(section); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return app.settings ? <Settings /> : null;
}

const MODEL = { id: "m1", name: "Local", kind: "ollama", base_url: "http://127.0.0.1:11434/v1", model: "qwen3", api_style: "chat",
  has_api_key: false, context_window: 16384, max_output_tokens: null, reasoning_effort: null, reasoning_capable: false, active: true };

beforeEach(() => {
  resetSeq();
  localStorage.setItem("saw.lang", "en");
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };
  vi.stubGlobal("EventSource", class { addEventListener() {} close() {} });
});

describe("v9: settings", () => {
  it("a new model stays selected after Save, with its test result", async () => {
    let models: unknown[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    serve((url, init) => {
      if (url.includes("/providers/models/m1/test")) return { ok: true, detail: "Reachable — qwen3 answered." };
      if (url.includes("/providers/models") && init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)));
        models = [MODEL];
        return MODEL;
      }
      if (url.includes("/providers/models")) return models;
      if (url.includes("/providers/clouds")) return [];
      return {};
    });
    await act(async () => { render(wrap(<OpenSettings section="models" />)); });
    const editor = await screen.findByTestId("model-editor");
    // A local preset shows the context window, prefilled with 16 384.
    fireEvent.change(editor.querySelector("select")!, { target: { value: "ollama" } });
    expect(screen.getByTestId("context-window")).toHaveValue("16384");
    fireEvent.change(screen.getByPlaceholderText("llama3.1"), { target: { value: "qwen3" } });
    await act(async () => { fireEvent.submit(screen.getByTestId("model-editor")); });
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("Reachable"));
    expect(bodies[0].context_window).toBe(16384);
    // The editor is the saved model now (Delete is offered), and the list marks it.
    expect(screen.getByTestId("model-editor")).toHaveTextContent("Delete");
    await waitFor(() => expect(document.querySelector(".provider-item[aria-current='true']")).toHaveTextContent("Local"));
    expect(screen.queryByText("No model yet.")).toBeNull();
  });

  it("a hosted model keeps its context window under Advanced", async () => {
    serve((url) => (url.includes("/providers/") ? [] : {}));
    await act(async () => { render(wrap(<OpenSettings section="models" />)); });
    await screen.findByTestId("model-editor");
    expect(screen.getByTestId("context-window").closest("details")).not.toBeNull();
  });

  it("a connection folds the session token and scope under Advanced", async () => {
    serve((url) => (url.includes("/providers/") ? [] : {}));
    await act(async () => { render(wrap(<OpenSettings section="connections" />)); });
    const advanced = await screen.findByTestId("cloud-advanced");
    expect(advanced).not.toHaveAttribute("open");
    expect(advanced).toHaveTextContent("Session token");
    expect(advanced).toHaveTextContent("Allowed buckets");
  });
});

describe("v9: the task page", () => {
  it("a failed turn says why, can continue, and points at the model settings", async () => {
    serve(() => ({}));
    const m = reduce(initial("task-1"), { type: "snapshot", snapshot: snapshot(
      [turn("t1", { status: "failed", error: "The model endpoint refused the key (401)." })],
      [item("t1", "user_message", { text: "Survey" })],
    ) });
    await act(async () => { render(wrap(<TaskPage model={m} setSnapshot={() => {}} />)); });
    const outcome = screen.getByTestId("attention");
    expect(outcome).toHaveTextContent("refused the key (401)");
    expect(outcome).toHaveTextContent("Open Settings");
    expect(outcome).toHaveTextContent("Continue");
  });

  it("durations read in the reader's language", () => {
    expect(formatDuration(1000)).toBe("1s");
    expect(formatDuration(250)).toBe("<1s");
    expect(formatDuration(65_000)).toBe("1m 05s");
    expect(formatDuration(1000, "zh")).toBe("1 秒");
    expect(formatDuration(250, "zh")).toBe("<1 秒");
    expect(formatDuration(65_000, "zh")).toBe("1 分 05 秒");
  });
});
