import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { I18nProvider } from "../i18n";
import { LiveTrace, argLabel, argSummary } from "./LiveTrace";
import { AgentTaskResult } from "./AgentTaskResult";
import { ExecutionSummary } from "./ExecutionSummary";
import type { ToolActivity } from "../types";

const wrap = (node: React.ReactNode) => render(createElement(I18nProvider, null, node));

const call = (over: Partial<ToolActivity> = {}): ToolActivity => ({
  tool: "list_objects",
  target: "acme-logs",
  result: "1000 keys",
  ...over,
});

describe("live Agent execution", () => {
  it("has one progress surface while the Agent is streaming", () => {
    wrap(createElement(AgentTaskResult, {
      role: "assistant",
      content: "",
      streaming: true,
      toolActivity: [call({ status: "started" }), call({ tool: "head_bucket" })],
    }));
    expect(screen.getAllByTestId("live-trace")).toHaveLength(1);
    expect(screen.queryByText(/checks run/i)).toBeNull();
  });

  it("shows arguments that change the meaning of a tool call", () => {
    wrap(createElement(LiveTrace, {
      items: [call({ args: { prefix: "logs/2026/08/", max_keys: 1000, recursive: true } })],
    }));
    const args = screen.getByTestId("trace-args").textContent ?? "";
    expect(args).toContain("logs/2026/08/");
    expect(args).toContain("1000");
    expect(args).toContain("recursive");
  });

  it("renders a bare row when there are no distinguishing arguments", () => {
    wrap(createElement(LiveTrace, { items: [call({ tool: "head_bucket", args: {} })] }));
    expect(screen.queryByTestId("trace-args")).toBeNull();
    expect(screen.getByText("head_bucket")).toBeTruthy();
  });

  it("marks only the in-flight call", () => {
    const { container } = wrap(createElement(LiveTrace, {
      items: [call({ tool: "head_bucket" }), call({ status: "started" })],
    }));
    expect(container.querySelectorAll(".animate-spin")).toHaveLength(1);
  });

  it("shows a finished result and does not invent a result for a running call", () => {
    wrap(createElement(LiveTrace, {
      items: [call({ result: "404 NoSuchBucket" }), call({ status: "started" })],
    }));
    expect(screen.getByText("404 NoSuchBucket")).toBeTruthy();
    expect(screen.getAllByText(/list_objects/)).toHaveLength(2);
  });

  it("renders nothing before the first call", () => {
    const { container } = wrap(createElement(LiveTrace, { items: [] }));
    expect(container.textContent).toBe("");
  });
});

describe("execution truth", () => {
  it("uses the sidecar verdict instead of guessing from result prose", () => {
    wrap(createElement(LiveTrace, {
      items: [call({ result: "AccessDenied · req 8A9F2C1B", ok: false })],
    }));
    expect(screen.getByTestId("trace-failed")).toBeTruthy();
  });

  it("does not invent a failure for a successful call", () => {
    wrap(createElement(LiveTrace, { items: [call({ result: "1000 keys", ok: true })] }));
    expect(screen.queryByTestId("trace-failed")).toBeNull();
  });

  it("still reads pre-verdict history conservatively", () => {
    wrap(createElement(LiveTrace, { items: [call({ result: "error: boom" })] }));
    expect(screen.getByTestId("trace-failed")).toBeTruthy();
  });

  it("shows measured call duration", () => {
    wrap(createElement(LiveTrace, { items: [call({ duration_ms: 4200 })] }));
    expect(screen.getByTestId("trace-duration").textContent).toBe("4.2s");
  });

  it("stays silent about sub-100ms jitter", () => {
    wrap(createElement(LiveTrace, { items: [call({ duration_ms: 12 })] }));
    expect(screen.queryByTestId("trace-duration")).toBeNull();
  });

  it("does not invent an unmeasured duration", () => {
    wrap(createElement(LiveTrace, { items: [call({ duration_ms: null })] }));
    expect(screen.queryByTestId("trace-duration")).toBeNull();
  });
});

describe("deep execution", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => call({ tool: `probe_${i}`, id: `c${i}` }));

  it("folds early steps so live execution does not bury the Work Result", () => {
    wrap(createElement(LiveTrace, { items: many(30) }));
    expect(screen.queryByText("probe_0")).toBeNull();
    expect(screen.getByText("probe_29")).toBeTruthy();
    expect(screen.getByTestId("trace-fold").textContent).toContain("24");
  });

  it("never folds a failure away", () => {
    const items = many(30);
    items[1] = call({ tool: "head_bucket", id: "boom", result: "NoSuchBucket", ok: false });
    wrap(createElement(LiveTrace, { items }));
    expect(screen.getByText("head_bucket")).toBeTruthy();
  });

  it("shows all steps once the operator asks", () => {
    wrap(createElement(LiveTrace, { items: many(30) }));
    fireEvent.click(screen.getByTestId("trace-fold"));
    expect(screen.getByText("probe_0")).toBeTruthy();
    expect(screen.queryByTestId("trace-fold")).toBeNull();
  });

  it("leaves a short execution alone", () => {
    wrap(createElement(LiveTrace, { items: many(5) }));
    expect(screen.queryByTestId("trace-fold")).toBeNull();
    expect(screen.getByText("probe_0")).toBeTruthy();
  });
});

describe("tool argument formatting", () => {
  it("reads like an operator writes it", () => {
    expect(argLabel("prefix", "logs/2026/")).toBe("logs/2026/");
    expect(argLabel("max_keys", 1000)).toBe("·1000");
    expect(argLabel("recursive", true)).toBe("·recursive");
  });

  it("keeps the discriminating head of a long opaque id", () => {
    const id = "2~aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdef";
    const out = argLabel("upload_id", id);
    expect(out.startsWith("2~aBcDeFgHiJ")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThan(id.length);
  });

  it("summarizes an empty or absent argument set as nothing", () => {
    expect(argSummary(undefined)).toBe("");
    expect(argSummary({})).toBe("");
  });
});

describe("Execution Summary cost and budget truth", () => {
  const tools = [call()];

  it("shows the cache hit rate beside input tokens", () => {
    wrap(createElement(ExecutionSummary, {
      tools,
      usage: { input_tokens: 12000, output_tokens: 800, cached_input_tokens: 9600 },
    }));
    expect(screen.getByTestId("cached-tokens").textContent).toContain("80%");
  });

  it("separates reasoning tokens from readable output", () => {
    wrap(createElement(ExecutionSummary, {
      tools,
      usage: { input_tokens: 900, output_tokens: 1400, reasoning_tokens: 1100 },
    }));
    expect(screen.getByTestId("reasoning-tokens").textContent).toContain("1.1k");
  });

  it("does not invent cache or reasoning detail when the endpoint omitted it", () => {
    wrap(createElement(ExecutionSummary, {
      tools,
      usage: { input_tokens: 12000, output_tokens: 800 },
    }));
    expect(screen.queryByTestId("cached-tokens")).toBeNull();
    expect(screen.queryByTestId("reasoning-tokens")).toBeNull();
  });

  it("reports a genuine cold cache", () => {
    wrap(createElement(ExecutionSummary, {
      tools,
      usage: { input_tokens: 12000, output_tokens: 800, cached_input_tokens: 0 },
    }));
    expect(screen.getByTestId("cached-tokens").textContent).toContain("0%");
  });

  it("does not clutter the result with zero reasoning tokens", () => {
    wrap(createElement(ExecutionSummary, {
      tools,
      usage: { input_tokens: 900, output_tokens: 400, reasoning_tokens: 0 },
    }));
    expect(screen.queryByTestId("reasoning-tokens")).toBeNull();
  });

  it("shows how much of the Agent execution budget was used", () => {
    wrap(createElement(ExecutionSummary, {
      tools,
      usage: { input_tokens: 90000, output_tokens: 6000, total_tokens: 96000 },
      budgetTokens: 640000,
    }));
    expect(screen.getByTestId("budget-share").textContent).toContain("15%");
  });

  it("does not compute budget share from an unknown total", () => {
    wrap(createElement(ExecutionSummary, {
      tools,
      usage: { input_tokens: 900 },
      budgetTokens: 640000,
    }));
    expect(screen.queryByTestId("budget-share")).toBeNull();
  });

  it("reports repeated calls answered without re-running", () => {
    wrap(createElement(ExecutionSummary, {
      tools,
      usage: { input_tokens: 900, output_tokens: 100 },
      repeatCallsAvoided: 3,
    }));
    expect(screen.getByTestId("repeat-calls-avoided").textContent).toContain("3");
  });

  it("does not advertise zero avoided repeats", () => {
    wrap(createElement(ExecutionSummary, {
      tools,
      usage: { input_tokens: 900, output_tokens: 100 },
      repeatCallsAvoided: 0,
    }));
    expect(screen.queryByTestId("repeat-calls-avoided")).toBeNull();
  });

  it("expands into the persisted execution trace", () => {
    wrap(createElement(ExecutionSummary, {
      tools,
      durationMs: 4200,
      usage: { input_tokens: 12000, output_tokens: 800, cached_input_tokens: 9600 },
    }));
    fireEvent.click(screen.getByTestId("execution-summary-toggle"));
    expect(screen.getByText("list_objects")).toBeTruthy();
  });
});

describe("audit-gap truth", () => {
  it("marks a call whose audit row could not be written", () => {
    wrap(createElement(LiveTrace, {
      items: [call({ audit_error: "OperationalError: disk I/O error" })],
    }));
    const mark = screen.getByTestId("trace-audit-gap");
    expect(mark).toBeInTheDocument();
    expect(mark.getAttribute("title") ?? "").toContain("disk I/O error");
  });

  it("says the call itself ran and was saved", () => {
    wrap(createElement(LiveTrace, {
      items: [call({ audit_error: "OperationalError: disk I/O error" })],
    }));
    expect(screen.getByTestId("trace-audit-gap").getAttribute("title") ?? "").toMatch(/ran and was saved/i);
  });

  it("is absent on a healthy call", () => {
    wrap(createElement(LiveTrace, { items: [call({ ok: true })] }));
    expect(screen.queryByTestId("trace-audit-gap")).toBeNull();
  });

  it("does not appear while a call is still running", () => {
    wrap(createElement(LiveTrace, {
      items: [call({ status: "started", audit_error: "x" })],
    }));
    expect(screen.queryByTestId("trace-audit-gap")).toBeNull();
  });
});
