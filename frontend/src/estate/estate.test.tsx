import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/Toast";
import { I18nProvider } from "../i18n";
import { AppProvider } from "../shell/context";
import { ThemeProvider } from "../theme";
import { BucketSheet } from "./BucketSheet";
import { IssueCard } from "./IssueCard";

const issue = {
  id: "i1", provider_id: "p1", provider_name: "Prod", bucket: "acme-www", code: "public_exposure",
  title: "Bucket is publicly exposed", severity: "high", status: "open", detail: null,
  first_seen_at: "2026-09-01T00:00:00Z", last_seen_at: "2026-09-02T00:00:00Z", resolved_at: null, resolved_by: null,
  source_task_id: null, fix: null, fixable: false, last_verified_at: null, last_verify_result: null,
};
const page = {
  provider_id: "p1", bucket: "acme-www", region: "us-east-1", last_checked_at: "2026-09-02T00:00:00Z",
  source_task_id: "task-9", posture: { publicly_exposed: true, encryption_status: "available", versioning_status: "not_configured" },
  issues: [issue],
  timeline: [
    { kind: "issue", at: "2026-09-02T00:00:00Z", source: "survey", event: "opened", issue_id: "i1",
      code: "public_exposure", title: "Bucket is publicly exposed", severity: "high" },
    { kind: "posture", at: "2026-09-01T00:00:00Z", source: "survey", task_id: null, first: true, changed: [], posture: {} },
  ],
  notes: [{ id: "n1", provider_id: "p1", bucket: "acme-www", text: "Serves the marketing site.", source: "agent",
    task_id: null, issue_id: null, created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" }],
};
const fixed = { ...issue, id: "i2", status: "fix_proposed", fixable: true, fix: {
  kind: "public_access_block", command: "aws s3api put-public-access-block --bucket acme-www", notes: ["Blocks public ACLs."],
  document: { BlockPublicAcls: true },
  formats: [
    { format: "cli", label: "AWS CLI", text: "aws s3api put-public-access-block --bucket acme-www" },
    { format: "terraform", label: "Terraform", text: 'resource "aws_s3_bucket_public_access_block" "acme_www" {}' },
    { format: "json", label: "PublicAccessBlockConfiguration", text: '{ "BlockPublicAcls": true }' },
  ] } };

let calls: Array<{ url: string; init?: RequestInit }> = [];

beforeEach(() => {
  calls = [];
  localStorage.setItem("saw.lang", "en");
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    let body: unknown = [];
    if (url.includes("/impact")) {
      body = { verdict: "caution", gaps: ["Counts are a lower bound."],
        points: [{ text: "2 of 3 requests to this bucket were anonymous.", evidence: "access_log", count: 2, total: 3 }] };
    } else if (url.includes("/estate/providers/p1/buckets/acme-www")) body = page;
    else if (url.endsWith("/notes") && init?.method === "POST") {
      body = { ...page.notes[0], id: "n2", source: "user", text: JSON.parse(String(init.body)).text };
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
});

function wrap(children: ReactNode) {
  return <ThemeProvider><I18nProvider><ToastProvider><AppProvider>{children}</AppProvider></ToastProvider></I18nProvider></ThemeProvider>;
}

describe("the bucket sheet", () => {
  it("shows what needs attention, what deviates in its configuration, the notes and its history", async () => {
    await act(async () => { render(wrap(<BucketSheet providerId="p1" bucket="acme-www" />)); });
    expect(await screen.findByText("Bucket is publicly exposed", { selector: ".issue-title" })).toBeInTheDocument();
    // Deviations first: exposure and a missing protection; a configured setting waits behind Show all.
    expect(screen.getByText("Publicly exposed")).toBeInTheDocument();
    expect(screen.getByText("Versioning")).toBeInTheDocument();
    expect(screen.queryByText("Default encryption")).toBeNull();
    fireEvent.click(screen.getByText("Show all 3"));
    expect(screen.getByText("Default encryption")).toBeInTheDocument();
    expect(screen.getByText("Serves the marketing site.")).toBeInTheDocument();
    expect(screen.getByTestId("timeline")).toHaveTextContent("Opened — Bucket is publicly exposed");
  });

  it("a note is added with Enter and kept on the bucket", async () => {
    await act(async () => { render(wrap(<BucketSheet providerId="p1" bucket="acme-www" />)); });
    const input = await screen.findByTestId("note-input");
    fireEvent.change(input, { target: { value: "Owned by growth." } });
    await act(async () => { fireEvent.submit(input.closest("form")!); });
    const post = calls.find((c) => c.url.endsWith("/notes") && c.init?.method === "POST");
    expect(JSON.parse(String(post?.init?.body))).toEqual({ text: "Owned by growth.", provider_id: "p1", bucket: "acme-www" });
    expect(screen.getByText("Owned by growth.")).toBeInTheDocument();
  });

  it("Ask about this bucket only fills the Composer — it never submits", async () => {
    await act(async () => { render(wrap(<BucketSheet providerId="p1" bucket="acme-www" />)); });
    await act(async () => { fireEvent.click(await screen.findByTestId("ask-bucket")); });
    expect(calls.some((c) => c.url.includes("/tasks") && c.init?.method === "POST")).toBe(false);
  });

  it("accepting a risk sits behind ⋯, asks why and sends the reason", async () => {
    await act(async () => { render(wrap(<ul><IssueCard issue={issue as never} onChange={() => {}} /></ul>)); });
    fireEvent.click(screen.getByText("Bucket is publicly exposed", { selector: ".issue-title" }));
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Accept risk" }));
    fireEvent.change(screen.getByLabelText(/Why is this acceptable/), { target: { value: "Static site." } });
    await act(async () => { fireEvent.submit(screen.getByLabelText(/Why is this acceptable/).closest("form")!); });
    const post = calls.find((c) => c.url.includes("/issues/i1/accept"));
    expect(JSON.parse(String(post?.init?.body))).toEqual({ accepted: true, reason: "Static site." });
  });
});

describe("a fix pack", () => {
  it("offers CLI, Terraform and JSON, and says what applying it would change", async () => {
    await act(async () => { render(wrap(<ul><IssueCard issue={fixed as never} onChange={() => {}} /></ul>)); });
    fireEvent.click(screen.getByText("Bucket is publicly exposed", { selector: ".issue-title" }));
    const pack = await screen.findByTestId("fix-pack");
    expect(pack.querySelector("pre")).toHaveTextContent("aws s3api put-public-access-block");
    fireEvent.click(screen.getByRole("button", { name: "Terraform" }));
    expect(pack.querySelector("pre")).toHaveTextContent('resource "aws_s3_bucket_public_access_block"');
    const impact = await screen.findByTestId("impact");
    expect(await screen.findByText("Check before applying")).toBeInTheDocument();
    expect(impact).toHaveTextContent("2 of 3 requests to this bucket were anonymous.");
    expect(impact).toHaveTextContent("Counts are a lower bound.");
  });
});
