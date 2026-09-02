/**
 * v0.56.0 — opening a step to see what it actually sent and got back.
 *
 * The sidecar has written every call's sanitized input and output to
 * `tool_calls` since v0.45.0, and v0.55.0 gave the thread row the SAME id as
 * that row — but none of it was reachable from the thread. A reader who wanted
 * to know what `list_objects · acme-logs` was called with had to open the
 * whole-session inspector and scroll to a guessed time window.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { I18nProvider } from "../i18n";
import { LiveTrace } from "./LiveTrace";
import type { ToolActivity } from "../types";

const getSessionCall = vi.fn();
vi.mock("../api", () => ({ getSessionCall: (...a: unknown[]) => getSessionCall(...a) }));

const wrap = (node: React.ReactNode) => {
  const out = render(createElement(I18nProvider, null, node));
  // A finished group is collapsed until the reader opens it (Codex parity);
  // these tests read the rows, so open it first.
  const head = screen.queryByTestId("execution-head");
  if (head && screen.getByTestId("worked-group").getAttribute("data-expanded") === "false") fireEvent.click(head);
  return out;
};
const call = (over: Partial<ToolActivity> = {}): ToolActivity => ({
  id: "c1", tool: "list_objects", target: "acme-logs", result: "1000 keys",
  ok: true, status: "completed", ...over,
});

beforeEach(() => {
  getSessionCall.mockReset();
  getSessionCall.mockResolvedValue({
    id: "c1", tool_name: "list_objects", status: "success", duration_ms: 120,
    created_at: "2026-08-05T00:00:00Z",
    input: { target: "acme-logs", prefix: "logs/2026/" },
    output: { summary: "1000 keys" },
  });
});

describe("opening a trace row", () => {
  it("shows what the call sent and what it returned", async () => {
    wrap(createElement(LiveTrace, { items: [call()], sessionId: "s1" }));
    fireEvent.click(screen.getByTestId("trace-row-open"));
    await waitFor(() => expect(screen.getByTestId("call-detail")).toBeTruthy());
    const text = screen.getByTestId("call-detail").textContent ?? "";
    expect(text).toContain("logs/2026/");
    expect(text).toContain("1000 keys");
    expect(getSessionCall).toHaveBeenCalledWith("s1", "c1");
  });

  it("fetches only when the reader asks", () => {
    wrap(createElement(LiveTrace, { items: [call()], sessionId: "s1" }));
    // A turn can run 60 tools; pre-fetching every payload would defeat the
    // point of the fold that keeps the answer on screen.
    expect(getSessionCall).not.toHaveBeenCalled();
  });

  it("closes again on a second click", async () => {
    wrap(createElement(LiveTrace, { items: [call()], sessionId: "s1" }));
    fireEvent.click(screen.getByTestId("trace-row-open"));
    await waitFor(() => expect(screen.getByTestId("call-detail")).toBeTruthy());
    fireEvent.click(screen.getByTestId("trace-row-open"));
    expect(screen.queryByTestId("call-detail")).toBeNull();
  });

  it("opens with the keyboard, not just the mouse", async () => {
    wrap(createElement(LiveTrace, { items: [call()], sessionId: "s1" }));
    const row = screen.getByTestId("trace-row-open");
    expect(row.getAttribute("tabIndex")).toBe("0");
    fireEvent.keyDown(row, { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("call-detail")).toBeTruthy());
  });

  it("keeps a still-running call closed", () => {
    wrap(createElement(LiveTrace, { items: [call({ status: "started" })], sessionId: "s1" }));
    // There is nothing persisted to open yet — the row resolves first.
    expect(screen.queryByTestId("trace-row-open")).toBeNull();
  });

  it("stays read-only for history that carries no call id", () => {
    wrap(createElement(LiveTrace, { items: [call({ id: undefined })], sessionId: "s1" }));
    expect(screen.queryByTestId("trace-row-open")).toBeNull();
  });

  it("says so plainly when the detail is gone", async () => {
    getSessionCall.mockRejectedValue(new Error("404 tool call not found"));
    wrap(createElement(LiveTrace, { items: [call()], sessionId: "s1" }));
    fireEvent.click(screen.getByTestId("trace-row-open"));
    // A pruned row is a real state (retention prunes tool_calls); it must read
    // as "gone", never as an empty payload that looks like the call sent nothing.
    await waitFor(() => expect(screen.getByTestId("call-detail-error")).toBeTruthy());
  });
});
