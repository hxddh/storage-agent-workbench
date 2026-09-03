/**
 * The context meter (v1.12): after a `context.compacted` frame or an
 * on-demand compaction the meter reads `after_tokens / context_window`, until
 * the next execution reports its own usage.
 */
import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { I18nProvider } from "../i18n";
import { ActiveTaskContext } from "../agent/activeTask";
import { dropSessionRun, getSessionRun, patchSessionRun } from "../sessionRuns";
import { liveHandlers } from "../hooks/useTurnRunnerImplementation";
import type { ExecutionMetrics } from "../types";
import { ContextMeter, contextUsage } from "./ContextMeter";

const metrics = (over: Partial<ExecutionMetrics> & { context_window?: number | null }) =>
  ({ messageId: "m1", metrics: over as ExecutionMetrics });

const mount = (taskId: string) => render(
  createElement(I18nProvider, null, createElement(ActiveTaskContext.Provider, { value: taskId }, createElement(ContextMeter))),
);

// A dropped id is retired for good (deleted tasks never come back), so each
// test owns one id and drops only that one.
let current: string | null = null;
const use = (id: string) => { current = id; return id; };
afterEach(() => { if (current) dropSessionRun(current); current = null; });

describe("the context meter after compaction", () => {
  it("drops to the compacted figure over the last execution's usage", () => {
    const id = use("ctx-compact");
    patchSessionRun(id, { lastMetrics: metrics({ usage: { total_tokens: 96_000 }, context_window: 128_000 }) });
    patchSessionRun(id, { contextTokens: 9_000 });
    mount(id);
    const meter = screen.getByTestId("context-meter");
    expect(meter.getAttribute("data-pct")).toBe("7");
    expect(meter.getAttribute("title")).toContain("9k of 128k");
  });

  it("takes the figure from a context.compacted frame on the live stream", () => {
    const id = use("ctx-frame");
    patchSessionRun(id, { lastMetrics: metrics({ usage: { total_tokens: 100_000 }, context_window: 200_000 }) });
    liveHandlers(id).onContextCompacted({ before_tokens: 100_000, after_tokens: 20_000, summary_chars: 1800 });
    const run = getSessionRun(id);
    expect(run.contextTokens).toBe(20_000);
    expect(run.items).toEqual([{ kind: "compacted", before_tokens: 100_000, after_tokens: 20_000 }]);
    mount(id);
    expect(screen.getByTestId("context-meter").getAttribute("data-pct")).toBe("10");
  });

  it("still needs a real window: a compacted figure alone paints nothing", () => {
    const id = use("ctx-fresh");
    patchSessionRun(id, { contextTokens: 9_000 });
    mount(id);
    expect(screen.queryByTestId("context-meter")).toBeNull();
    expect(contextUsage(null, 9_000)).toBeNull();
    expect(contextUsage({ usage: { total_tokens: 50_000 }, context_window: 100_000 } as ExecutionMetrics, 9_000)?.pct).toBe(9);
    expect(contextUsage({ usage: { total_tokens: 50_000 }, context_window: 100_000 } as ExecutionMetrics, null)?.pct).toBe(50);
  });
});
