import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/Toast";
import { I18nProvider } from "../i18n";
import { AppProvider } from "../shell/context";
import { ThemeProvider } from "../theme";
import { EstatePage } from "./EstatePage";

const issue = {
  id: "i1", provider_id: "p1", provider_name: "Prod", bucket: "acme-www", code: "public_exposure",
  title: "Bucket is publicly exposed", severity: "high", status: "open", detail: null,
  first_seen_at: "2026-09-01T00:00:00Z", last_seen_at: "2026-09-02T00:00:00Z", resolved_at: null, resolved_by: null,
  source_task_id: null, fix: null, fixable: false, last_verified_at: null, last_verify_result: null,
};
const page = {
  provider_id: "p1", bucket: "acme-www", region: "us-east-1", last_checked_at: "2026-09-02T00:00:00Z",
  source_task_id: "task-9", posture: { publicly_exposed: true, encryption_status: "available" },
  issues: [issue],
  timeline: [
    { kind: "issue", at: "2026-09-02T00:00:00Z", source: "survey", event: "opened", issue_id: "i1",
      code: "public_exposure", title: "Bucket is publicly exposed", severity: "high" },
    { kind: "posture", at: "2026-09-01T00:00:00Z", source: "survey", task_id: null, first: true, changed: [], posture: {} },
  ],
  notes: [{ id: "n1", provider_id: "p1", bucket: "acme-www", text: "Serves the marketing site.", source: "agent",
    task_id: null, issue_id: null, created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" }],
};
const estate = { providers: [{ provider_id: "p1", name: "Prod", provider_type: "aws", bucket_count: 1,
  last_checked_at: null, open_issues: { high: 1, medium: 0, low: 0 }, watch: { enabled: false, interval_hours: 24 } }],
  bucket_count: 1, issues: [issue], open_issue_count: 1, last_watch_at: null };

let calls: Array<{ url: string; init?: RequestInit }> = [];

beforeEach(() => {
  calls = [];
  localStorage.setItem("saw.lang", "en");
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    let body: unknown = [];
    if (url.includes("/estate/providers/p1/buckets/acme-www")) body = page;
    else if (url.includes("/estate/providers/p1/buckets")) {
      body = { buckets: [{ bucket: "acme-www", region: "us-east-1", last_checked_at: null, open_issues: { high: 1, medium: 0, low: 0 } }], notes: [] };
    } else if (url.includes("/estate")) body = estate;
    else if (url.endsWith("/notes") && init?.method === "POST") {
      body = { ...page.notes[0], id: "n2", source: "user", text: JSON.parse(String(init.body)).text };
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
});

function wrap(children: ReactNode) {
  return <ThemeProvider><I18nProvider><ToastProvider><AppProvider>{children}</AppProvider></ToastProvider></I18nProvider></ThemeProvider>;
}

describe("the estate view", () => {
  it("an account lists its buckets, most in need of care first", async () => {
    await act(async () => { render(wrap(<EstatePage providerId="p1" />)); });
    expect(await screen.findByTestId("bucket-row")).toHaveTextContent("acme-www");
    expect(screen.getByTestId("bucket-row")).toHaveTextContent("1");
  });

  it("a bucket page shows what is known, its issues, the notes and how it changed", async () => {
    await act(async () => { render(wrap(<EstatePage providerId="p1" bucket="acme-www" />)); });
    expect(await screen.findByText("Bucket is publicly exposed", { selector: ".issue-title" })).toBeInTheDocument();
    expect(screen.getByText("Publicly exposed")).toBeInTheDocument();
    expect(screen.getByText("Serves the marketing site.")).toBeInTheDocument();
    expect(screen.getByText("Agent", { exact: false, selector: ".note-meta" })).toBeInTheDocument();
    const timeline = screen.getByTestId("timeline");
    expect(timeline).toHaveTextContent("Opened — Bucket is publicly exposed");
    expect(timeline).toHaveTextContent("First observed");
  });

  it("a note the user adds is kept on the bucket", async () => {
    await act(async () => { render(wrap(<EstatePage providerId="p1" bucket="acme-www" />)); });
    const input = await screen.findByTestId("note-input");
    fireEvent.change(input, { target: { value: "Owned by growth." } });
    await act(async () => { fireEvent.click(screen.getByTestId("note-add")); });
    const post = calls.find((c) => c.url.endsWith("/notes") && c.init?.method === "POST");
    expect(JSON.parse(String(post?.init?.body))).toEqual({ text: "Owned by growth.", provider_id: "p1", bucket: "acme-www" });
    expect(screen.getByText("Owned by growth.")).toBeInTheDocument();
  });

  it("Ask about this bucket only fills the Composer — it never submits", async () => {
    await act(async () => { render(wrap(<EstatePage providerId="p1" bucket="acme-www" />)); });
    await act(async () => { fireEvent.click(await screen.findByTestId("ask-bucket")); });
    expect(calls.some((c) => c.url.includes("/tasks") && c.init?.method === "POST")).toBe(false);
    expect(window.location.hash === "" || window.location.hash === "#/").toBe(true);
  });

  it("accepting a risk asks why and sends the reason", async () => {
    await act(async () => { render(wrap(<EstatePage providerId="p1" bucket="acme-www" />)); });
    fireEvent.click(await screen.findByText("Bucket is publicly exposed", { selector: ".issue-title" }));
    fireEvent.click(screen.getByText("Accept risk"));
    fireEvent.change(screen.getByLabelText(/Why is this acceptable/), { target: { value: "Static site." } });
    await act(async () => { fireEvent.submit(screen.getByLabelText(/Why is this acceptable/).closest("form")!); });
    const post = calls.find((c) => c.url.includes("/issues/i1/accept"));
    expect(JSON.parse(String(post?.init?.body))).toEqual({ accepted: true, reason: "Static site." });
  });
});
