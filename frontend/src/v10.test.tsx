import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./composer/Composer";
import { ToastProvider } from "./components/Toast";
import { Home } from "./home/Home";
import { I18nProvider } from "./i18n";
import { Settings } from "./settings/Settings";
import { AppProvider, useApp } from "./shell/context";
import { initial, reduce } from "./store/task";
import { TaskPage } from "./task/TaskPage";
import { item, resetSeq, snapshot, turn } from "./test/fixtures";
import { ThemeProvider } from "./theme";

type Route = (url: string, init?: RequestInit) => unknown | Promise<unknown>;

function serve(route: Route) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = (await route(url, init)) ?? {};
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

const model = (id: string, name: string, active = false) => ({ id, name, kind: "ollama", base_url: "http://127.0.0.1:11434/v1",
  model: name.toLowerCase(), api_style: "chat", has_api_key: false, context_window: 16384, max_output_tokens: null,
  reasoning_effort: null, reasoning_capable: false, active });

beforeEach(() => {
  resetSeq();
  localStorage.setItem("saw.lang", "en");
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };
  vi.stubGlobal("EventSource", class { addEventListener() {} close() {} });
});

describe("v10: settings", () => {
  it("a slow save never pulls the reader back from the item they moved to", async () => {
    const models = [model("m1", "Alpha", true), model("m2", "Beta")];
    let release: () => void = () => {};
    serve((url, init) => {
      if (url.includes("/providers/models/m1/test")) return new Promise((r) => { release = () => r({ ok: true, detail: "ok" }); });
      if (url.includes("/providers/models/m1") && init?.method === "PUT") return models[0];
      if (url.includes("/providers/models")) return models;
      if (url.includes("/providers/clouds")) return [];
      return {};
    });
    await act(async () => { render(wrap(<OpenSettings section="models" />)); });
    fireEvent.click(await screen.findByText("Alpha"));
    await act(async () => { fireEvent.submit(screen.getByTestId("model-editor")); });
    fireEvent.click(screen.getByText("Beta"));
    await act(async () => { release(); });
    await waitFor(() => expect(document.querySelector(".provider-item[aria-current='true']")).toHaveTextContent("Beta"));
    expect(screen.queryByTestId("probe")).toBeNull();
  });

  it("deleting a model asks first", async () => {
    const del = vi.fn();
    serve((url, init) => {
      if (init?.method === "DELETE") { del(); return {}; }
      if (url.includes("/providers/models")) return [model("m1", "Alpha", true)];
      if (url.includes("/providers/clouds")) return [];
      return {};
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await act(async () => { render(wrap(<OpenSettings section="models" />)); });
    fireEvent.click(await screen.findByText("Alpha"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(confirm).toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    confirm.mockRestore();
  });
});

describe("v10: composer", () => {
  it("with no model, Send waits instead of starting a task that can only fail", async () => {
    serve((url) => (url.includes("/providers/") ? [] : {}));
    await act(async () => { render(wrap(<Composer taskId={null} busy={false} />)); });
    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "Why is my bucket slow?" } });
    await waitFor(() => expect(screen.getByTestId("model-chip")).toHaveTextContent("Set up a model"));
    expect(screen.getByTestId("composer-send")).toBeDisabled();
  });
});

describe("v10: the task page", () => {
  it("a steer shows as the reader's own words while work is live", async () => {
    serve(() => ({}));
    const m = reduce(initial("task-1"), { type: "snapshot", snapshot: snapshot(
      [turn("t1", { status: "running", finished_at: null })],
      [item("t1", "user_message", { text: "Survey" }), item("t1", "steer", { text: "only acme-www" })],
      { state: "working", running_turn_id: "t1" },
    ) });
    await act(async () => { render(wrap(<TaskPage model={m} setSnapshot={() => {}} />)); });
    expect(screen.getByText("only acme-www").closest("p")).toHaveTextContent("You added: only acme-www");
  });

  it("a stopped turn keeps its partial answer on the page", async () => {
    serve(() => ({}));
    const m = reduce(initial("task-1"), { type: "snapshot", snapshot: snapshot(
      [turn("t1", { status: "cancelled" })],
      [item("t1", "user_message", { text: "Survey" }), item("t1", "agent_message", { text: "Two buckets are public so far." }),
        item("t1", "notice", { event: "cancelled" })],
    ) });
    await act(async () => { render(wrap(<TaskPage model={m} setSnapshot={() => {}} />)); });
    expect(screen.getByTestId("answer")).toHaveTextContent("Two buckets are public so far.");
    expect(screen.getByText(/^Stopped\./)).toBeTruthy();
  });
});

describe("v10: home", () => {
  it("Needs attention keeps a stable order: severity, then title; buckets by name", async () => {
    const issue = (id: string, bucket: string, code: string, title: string, severity: string) => ({
      id, provider_id: "p1", bucket, code, title, severity, status: "open", detail: "", fixable: true, fix: null, source_task_id: null,
    });
    serve((url) => {
      if (url.includes("/providers/clouds")) return [{ id: "p1", name: "acme-prod" }];
      if (url.includes("/providers/models")) return [model("m1", "Alpha", true)];
      if (url.includes("/estate")) {
        return { providers: [{ provider_id: "p1", name: "acme-prod", provider_type: "aws-s3", bucket_count: 3, last_checked_at: "2026-09-30T00:00:00Z",
          open_issues: { high: 1, medium: 3, low: 0 }, watch: { enabled: false, interval_hours: 24 } }], open_issue_count: 4,
          issues: [issue("a", "acme-www", "no_default_encryption", "No default encryption", "medium"),
            issue("b", "acme-data", "no_default_encryption", "No default encryption", "medium"),
            issue("c", "acme-logs", "no_abort_mpu", "Incomplete multipart uploads are never cleaned up", "medium"),
            issue("d", "acme-www", "public_exposure", "Bucket is publicly accessible", "high")] };
      }
      return {};
    });
    await act(async () => { render(wrap(<Home />)); });
    const rows = await screen.findAllByTestId("issue");
    expect(rows.map((r) => r.querySelector(".attention-issue")?.textContent)).toEqual([
      "Bucket is publicly accessible", "Incomplete multipart uploads are never cleaned up", "No default encryption"]);
    expect([...rows[2].querySelectorAll("[data-testid=issue-bucket]")].map((b) => b.textContent)).toEqual(["acme-data", "acme-www"]);
  });
});
