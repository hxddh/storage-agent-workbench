/**
 * v0.53.0 — what the thread says while it works, and what a turn cost.
 *
 * The live state carried the duplication v0.49.0 removed from the finished
 * state: a summary line ("5 checks run · list_objects · acme-logs") rendered
 * directly above a full list of those same calls. Two components, one event
 * stream, stacked — and neither showed the arguments that decide what a call
 * MEANS, even though the sidecar had been recording them to `tool_calls` all
 * along.
 *
 * Separately, the footer showed input and output tokens but not the two numbers
 * that explain the bill: how much of the input the endpoint served from cache
 * (the fixed prefix is re-sent on every step of a multi-step turn) and how much
 * of the output was reasoning.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { createElement } from "react";
import { I18nProvider } from "../i18n";
import { LiveTrace, argLabel, argSummary } from "./LiveTrace";
import { MessageCard } from "./ThreadCards";
import { TurnFooter } from "./TurnFooter";
import type { ToolActivity } from "../types";

const wrap = (node: React.ReactNode) => render(createElement(I18nProvider, null, node));

const call = (over: Partial<ToolActivity> = {}): ToolActivity => ({
  tool: "list_objects",
  target: "acme-logs",
  result: "1000 keys",
  ...over,
});

describe("the live trace", () => {
  it("is the ONLY progress surface while streaming", () => {
    wrap(createElement(MessageCard, {
      role: "assistant", content: "", streaming: true,
      toolActivity: [call({ status: "started" }), call({ tool: "head_bucket" })],
    }));
    // One list, not a list plus a counter above it saying the same thing.
    expect(screen.getAllByTestId("live-trace").length).toBe(1);
    expect(screen.queryByText(/checks run/)).toBeNull();
  });

  it("shows the arguments that decide what the call meant", () => {
    wrap(createElement(LiveTrace, {
      items: [call({ args: { prefix: "logs/2026/08/", max_keys: 1000, recursive: true } })],
    }));
    const args = screen.getByTestId("trace-args").textContent ?? "";
    // `list_objects · acme-logs` described a one-prefix scan and a full bucket
    // walk identically.
    expect(args).toContain("logs/2026/08/");
    expect(args).toContain("1000");
    expect(args).toContain("recursive");
  });

  it("renders a bare row when there are no distinguishing arguments", () => {
    wrap(createElement(LiveTrace, { items: [call({ tool: "head_bucket", args: {} })] }));
    expect(screen.queryByTestId("trace-args")).toBeNull();
    expect(screen.getByText("head_bucket")).toBeTruthy();
  });

  it("marks the in-flight call and no other", () => {
    const { container } = wrap(createElement(LiveTrace, {
      items: [call({ tool: "head_bucket" }), call({ status: "started" })],
    }));
    expect(container.querySelectorAll(".animate-spin").length).toBe(1);
  });

  it("shows a finished call's result, and a running one's state instead", () => {
    wrap(createElement(LiveTrace, {
      items: [call({ result: "404 NoSuchBucket" }), call({ status: "started" })],
    }));
    expect(screen.getByText("404 NoSuchBucket")).toBeTruthy();
    // A running call has no result yet; printing a stale one would be a lie.
    expect(screen.getAllByText(/list_objects/).length).toBe(2);
  });

  it("renders nothing before the first call", () => {
    const { container } = wrap(createElement(LiveTrace, { items: [] }));
    expect(container.textContent).toBe("");
  });
});

describe("argument formatting", () => {
  it("reads like an operator writes it", () => {
    expect(argLabel("prefix", "logs/2026/")).toBe("logs/2026/");
    expect(argLabel("max_keys", 1000)).toBe("·1000");
    expect(argLabel("recursive", true)).toBe("·recursive");
  });

  it("keeps the head of a long opaque id", () => {
    const id = "2~aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdef";
    const out = argLabel("upload_id", id);
    // Truncated in the middle an id is unreadable; the head is what
    // distinguishes one upload from another.
    expect(out.startsWith("2~aBcDeFgHiJ")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThan(id.length);
  });

  it("summarizes an empty or absent arg set as nothing", () => {
    expect(argSummary(undefined)).toBe("");
    expect(argSummary({})).toBe("");
  });
});

describe("what a turn cost", () => {
  const tools = [call()];

  it("shows the cache hit rate beside the input count", () => {
    wrap(createElement(TurnFooter, {
      tools,
      usage: { input_tokens: 12000, output_tokens: 800, cached_input_tokens: 9600 },
    }));
    // The fixed prefix is re-sent on every step, so the hit rate — not the raw
    // input count — is what the turn actually cost.
    expect(screen.getByTestId("cached-tokens").textContent).toContain("80%");
  });

  it("separates reasoning from the output the user can read", () => {
    wrap(createElement(TurnFooter, {
      tools,
      usage: { input_tokens: 900, output_tokens: 1400, reasoning_tokens: 1100 },
    }));
    expect(screen.getByTestId("reasoning-tokens").textContent).toContain("1.1k");
  });

  it("says nothing when the endpoint did not report the details", () => {
    wrap(createElement(TurnFooter, {
      tools, usage: { input_tokens: 12000, output_tokens: 800 },
    }));
    // Absent is not zero: claiming a 0% hit rate would be a measurement we
    // never made.
    expect(screen.queryByTestId("cached-tokens")).toBeNull();
    expect(screen.queryByTestId("reasoning-tokens")).toBeNull();
  });

  it("reports a genuine cold cache, which is the actionable case", () => {
    wrap(createElement(TurnFooter, {
      tools, usage: { input_tokens: 12000, output_tokens: 800, cached_input_tokens: 0 },
    }));
    expect(screen.getByTestId("cached-tokens").textContent).toContain("0%");
  });

  it("does not clutter the line with a zero reasoning count", () => {
    wrap(createElement(TurnFooter, {
      tools, usage: { input_tokens: 900, output_tokens: 400, reasoning_tokens: 0 },
    }));
    // A non-reasoning model reports 0 every turn; that is noise, not news.
    expect(screen.queryByTestId("reasoning-tokens")).toBeNull();
  });

  it("still expands to the execution trace", () => {
    const onOpen = vi.fn();
    wrap(createElement(TurnFooter, {
      tools, durationMs: 4200, onOpenInspector: onOpen,
      usage: { input_tokens: 12000, output_tokens: 800, cached_input_tokens: 9600 },
    }));
    fireEvent.click(screen.getByTestId("turn-footer-toggle"));
    expect(screen.getByText("list_objects")).toBeTruthy();
  });
});
