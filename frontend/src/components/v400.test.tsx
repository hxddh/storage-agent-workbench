/**
 * v4.0.0 — the estate is the object; tasks are how work is done. The home is
 * "what to care about now": a readiness check when a model or storage account
 * is missing, starters that need storage say so, and the estate's open issues
 * — each opening the task that found it, with a fix the user applies and a
 * read-only Verify.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import type { EstateIssue, EstateOverview } from "../api";

const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetModules(); vi.doUnmock("../api"); });

const issue = (over: Partial<EstateIssue> = {}): EstateIssue => ({
  id: "i1", provider_id: "p1", bucket: "acme-logs", code: "public_access_block_missing",
  title: "Public access block not fully enabled", severity: "medium", status: "open",
  detail: "Bucket has no public access block.", first_seen_at: "2026-09-28T10:00:00Z",
  last_seen_at: "2026-09-28T10:00:00Z", resolved_at: null, resolved_by: null,
  source_task_id: "task-found-it", fix: null, fixable: true, last_verified_at: null,
  last_verify_result: null, ...over,
});

const estate = (issues: EstateIssue[]): EstateOverview => ({
  providers: [{
    provider_id: "p1", name: "prod", provider_type: "s3", bucket_count: 12,
    last_checked_at: "2026-09-28T10:00:00Z", open_issues: { high: 0, medium: issues.length, low: 0 },
    watch: { enabled: false, interval_hours: 24, next_run_at: null, last_run_at: null,
      last_status: null, last_summary: null, last_task_id: null },
  }],
  bucket_count: 12, open_issue_count: issues.length, issues, last_watch_at: null,
});

async function renderStart(api: Record<string, unknown>, home: Record<string, unknown> = {}) {
  vi.doMock("../api", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../api")>()),
    listModelProviders: () => Promise.resolve([{ id: "m1", name: "fake", model: "gpt-x", active: true }]),
    listCloudProviders: () => Promise.resolve([{ id: "p1" }]),
    getEstate: () => Promise.resolve(estate([])),
    ...api,
  }));
  const { TaskStart } = await import("./TaskStart");
  const { I18nProvider } = await import("../i18n");
  render(
    <I18nProvider>
      <TaskStart composerNode={<div />} banners={null} onStarter={() => {}} home={{ sidecarReady: true, ...home }} />
    </I18nProvider>,
  );
}

describe("v4.0 readiness", () => {
  it("says what is missing before work is delegated, and starters that need storage say so", async () => {
    await renderStart({ listCloudProviders: () => Promise.resolve([]), getEstate: () => Promise.resolve({ ...estate([]), providers: [] }) });
    await waitFor(() => expect(screen.getByTestId("readiness")).toBeInTheDocument());
    expect(screen.getByTestId("readiness-storage")).toHaveAttribute("data-ready", "false");
    expect(screen.getByTestId("readiness-model")).toHaveAttribute("data-ready", "true");
    const starters = screen.getAllByTestId("start-starter");
    expect(starters.filter((s) => s.getAttribute("data-needs-storage") === "true")).toHaveLength(2);
    expect(screen.getAllByText("Needs a storage account — add one in Settings")).toHaveLength(2);
  });

  it("paints nothing when the model and storage are both there", async () => {
    await renderStart({});
    await waitFor(() => expect(screen.getByTestId("estate-panel")).toBeInTheDocument());
    expect(screen.queryByTestId("readiness")).toBeNull();
    expect(screen.getByTestId("estate-all-clear")).toBeInTheDocument();
  });

  it("does not claim a prerequisite is missing when the runtime could not be read", async () => {
    await renderStart({
      listModelProviders: () => Promise.reject(new Error("offline")),
      listCloudProviders: () => Promise.reject(new Error("offline")),
      getEstate: () => Promise.reject(new Error("offline")),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("readiness")).toBeNull();
  });
});

describe("v4.0 the estate on the home", () => {
  it("lists what needs care, opens the task that found it, and generates a fix the user applies", async () => {
    const onOpenTask = vi.fn();
    const proposeIssueFix = vi.fn(() => Promise.resolve(issue({
      status: "fix_proposed",
      fix: { kind: "public_access_block", document: {}, command: "aws s3api put-public-access-block --bucket acme-logs", notes: [] },
    })));
    await renderStart({ getEstate: () => Promise.resolve(estate([issue()])), proposeIssueFix }, { onOpenTask });
    await waitFor(() => expect(screen.getByTestId("estate-issues")).toBeInTheDocument());
    expect(screen.getByTestId("estate-meta")).toHaveTextContent("1 account(s) · 12 bucket(s)");
    fireEvent.click(screen.getByText("Public access block not fully enabled"));
    fireEvent.click(screen.getByText("Open task"));
    expect(onOpenTask).toHaveBeenCalledWith("task-found-it");
    fireEvent.click(screen.getByText("Generate fix"));
    await waitFor(() => expect(screen.getByTestId("issue-fix")).toHaveTextContent("put-public-access-block"));
    expect(proposeIssueFix).toHaveBeenCalledWith("i1", "en");
    expect(screen.getByTestId("estate-issue")).toHaveAttribute("data-status", "fix_proposed");
  });

  it("verifies read-only and keeps the outcome in place", async () => {
    const verifyIssue = vi.fn(() => Promise.resolve({ result: "resolved", issue: issue({
      status: "resolved", last_verify_result: "resolved", last_verified_at: new Date().toISOString() }) }));
    await renderStart({ getEstate: () => Promise.resolve(estate([issue()])), verifyIssue });
    await waitFor(() => expect(screen.getByTestId("estate-issues")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Public access block not fully enabled"));
    fireEvent.click(screen.getByTestId("issue-verify"));
    await waitFor(() => expect(screen.getByTestId("issue-verify-result")).toHaveTextContent("Resolved — checked"));
    expect(screen.getByTestId("estate-issue")).toHaveAttribute("data-status", "resolved");
  });

  it("never submits Agent work: the home has no second submit path", () => {
    const home = source("./EstateHome.tsx") + source("../api/estate.ts");
    expect(home).not.toContain("createTaskExecution");
    expect(home).not.toContain("/executions");
    expect(source("../api.ts")).toContain('export * from "./api/estate"');
  });
});

describe("v4.0 proactive watch", () => {
  const watchState = { enabled: false, interval_hours: 24, next_run_at: null, last_run_at: null,
    last_status: null, last_summary: null, last_task_id: null, running: false };

  it("is off by default in Settings and turns on with an interval", async () => {
    const setProviderWatch = vi.fn((_id: string, enabled: boolean, hours: number) =>
      Promise.resolve({ ...watchState, enabled, interval_hours: hours }));
    vi.doMock("../api", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../api")>()),
      getProviderWatch: () => Promise.resolve(watchState),
      setProviderWatch,
    }));
    const { ProviderWatch } = await import("../settings/ProviderWatch");
    const { I18nProvider } = await import("../i18n");
    render(<I18nProvider><ProviderWatch providerId="p1" /></I18nProvider>);
    await waitFor(() => expect(screen.getByTestId("provider-watch")).toHaveAttribute("data-enabled", "false"));
    expect(screen.getByRole("button", { name: "Off" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Daily" }));
    await waitFor(() => expect(screen.getByTestId("provider-watch")).toHaveAttribute("data-enabled", "true"));
    expect(setProviderWatch).toHaveBeenCalledWith("p1", true, 24);
  });

  it("notifies once per sweep that found something, never on the first read", async () => {
    const notify = vi.fn(() => Promise.resolve(true));
    vi.doMock("../hooks/useNativeAgent", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../hooks/useNativeAgent")>()), notifyNative: notify }));
    let lastRun = "2026-09-28T10:00:00Z";
    vi.doMock("../api", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../api")>()),
      getEstate: () => Promise.resolve({ ...estate([]), providers: [{ ...estate([]).providers[0],
        watch: { ...watchState, enabled: true, last_status: "found", last_run_at: lastRun, last_summary: "2 new" } }] }),
    }));
    localStorage.removeItem("saw.watch.seen");
    const { useWatchAlerts } = await import("../hooks/useWatchAlerts");
    const { I18nProvider } = await import("../i18n");
    const onFound = vi.fn();
    function Probe() { useWatchAlerts(true, onFound); return null; }
    const first = render(<I18nProvider><Probe /></I18nProvider>);
    await waitFor(() => expect(localStorage.getItem("saw.watch.seen")).toBe(lastRun));
    expect(notify).not.toHaveBeenCalled();
    first.unmount();
    lastRun = "2026-09-28T11:00:00Z";
    render(<I18nProvider><Probe /></I18nProvider>);
    await waitFor(() => expect(notify).toHaveBeenCalledWith("Watch: prod", "2 new"));
    expect(onFound).toHaveBeenCalledTimes(1);
    expect(source("../hooks/useWatchAlerts.ts")).not.toContain("createTaskExecution");
  });
});
