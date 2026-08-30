/**
 * The per-turn metrics footer (v0.45.0).
 *
 * The property under test is honesty. Duration and tool counts are measured, so
 * they render. Token usage is frequently NOT reported by OpenAI-compatible
 * endpoints — and a fabricated "0 tokens" would be a false claim about spend, so
 * the absence has to stay visible as an absence.
 */
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { createElement } from "react";
import { I18nProvider } from "../i18n";
import { TurnMetricsBar, fmtDuration, fmtTokens } from "./ExecutionMetrics";
import type { ToolActivity } from "../types";

const draw = (props: Parameters<typeof TurnMetricsBar>[0]) =>
  render(createElement(I18nProvider, null, createElement(TurnMetricsBar, props)));

const call = (tool: string, result = "ok"): ToolActivity => ({ tool, target: "b", result });

describe("duration formatting", () => {
  it("reads the way a person reads a wait", () => {
    expect(fmtDuration(840)).toBe("840ms");
    expect(fmtDuration(12_400)).toBe("12.4s");
    expect(fmtDuration(72_000)).toBe("1m 12s");
  });

  it("returns null rather than inventing a value", () => {
    expect(fmtDuration(null)).toBeNull();
    expect(fmtDuration(undefined)).toBeNull();
    expect(fmtDuration(-1)).toBeNull();
  });
});

describe("token formatting", () => {
  it("keeps small counts exact and abbreviates large ones", () => {
    // Rounding 812 to "0.8k" would discard precision the provider gave us.
    expect(fmtTokens(812)).toBe("812");
    expect(fmtTokens(4235)).toBe("4.2k");
    expect(fmtTokens(128_000)).toBe("128k");
    expect(fmtTokens(2_400_000)).toBe("2.4M");
  });

  it("has no value for a missing count", () => {
    expect(fmtTokens(null)).toBeNull();
    expect(fmtTokens(undefined)).toBeNull();
  });
});

describe("the footer", () => {
  it("shows what was measured", () => {
    draw({
      durationMs: 12_400,
      usage: { input_tokens: 4235, output_tokens: 380 },
      tools: [call("list_objects"), call("head_bucket")],
    });
    expect(screen.getByText("12.4s")).toBeTruthy();
    expect(screen.getByText(/2 tool calls/)).toBeTruthy();
    expect(screen.getByText(/4\.2k/)).toBeTruthy();
    expect(screen.getByText(/380/)).toBeTruthy();
  });

  it("says tokens are unavailable instead of showing a zero", () => {
    draw({ durationMs: 3000, usage: null, tools: [call("head_bucket")] });
    // A "0" here would be a lie about real spend.
    expect(screen.queryByText("0")).toBeNull();
    expect(screen.getByTitle(/did not report token usage/i)).toBeTruthy();
  });

  it("renders nothing at all when nothing was measured", () => {
    // Pre-v0.45.0 history has no metrics row; a line of em dashes would read as
    // a broken turn rather than an unrecorded one.
    const { container } = draw({ durationMs: null, usage: null, tools: [] });
    expect(container.textContent).toBe("");
  });

  it("expands into which tools ran, not just how many", () => {
    draw({
      durationMs: 1000,
      tools: [call("list_objects"), call("list_objects"), call("head_bucket")],
    });
    expect(screen.queryByText("list_objects")).toBeNull();
    fireEvent.click(screen.getByText(/3 tool calls/));
    expect(screen.getByText("list_objects")).toBeTruthy();
    expect(screen.getByText("head_bucket")).toBeTruthy();
  });

  it("does not count an in-flight call as a completed one", () => {
    draw({
      durationMs: 1000,
      tools: [call("head_bucket"), { ...call("list_objects"), status: "started" }],
    });
    expect(screen.getByText(/1 tool calls/)).toBeTruthy();
  });

  // --- model calls when the endpoint reports no tokens (v0.77.0) ------------

  it("shows the model-call count when the endpoint reported no tokens", () => {
    // Many OpenAI-compatible endpoints omit usage on streamed responses. The
    // request count is not a provider figure — the SDK counts the calls it makes
    // — so it survives, and it is the difference between a one-shot answer and a
    // six-step investigation. Before v0.77.0 both rendered as a bare em dash.
    draw({ durationMs: 2000, usage: { requests: 4 }, tools: [] });
    expect(screen.getByText(/4 model calls/)).toBeTruthy();
    expect(screen.getByTitle(/did not report token usage/i)).toBeTruthy();
    // …and still no invented token figures.
    expect(screen.queryByText("0")).toBeNull();
  });

  it("does not repeat the model-call count when tokens ARE reported", () => {
    // With real token counts the row already says what the turn cost; the call
    // count is in the expandable breakdown, and duplicating it is noise.
    draw({ durationMs: 2000, usage: { requests: 4, input_tokens: 900, output_tokens: 120 }, tools: [] });
    expect(screen.queryByText(/model calls/)).toBeNull();
  });

  it("shows no model-call count when there is none", () => {
    draw({ durationMs: 2000, usage: { requests: 0 }, tools: [] });
    expect(screen.queryByText(/model calls/)).toBeNull();
  });

  it("marks token counts as a FLOOR when only some model calls reported usage", () => {
    // Three calls, one of them reported. Rendering "↑900" bare would state a
    // total the endpoint never gave us — the same lie the em-dash branch already
    // refuses to tell when nothing is reported at all.
    const { container } = draw({
      durationMs: 2000,
      usage: { requests: 3, reported_requests: 1, input_tokens: 900, output_tokens: 120 },
      tools: [],
    });
    expect(container.textContent).toContain("≥");
    expect(screen.getByTitle(/only 1 of this execution's 3 model calls/i)).toBeTruthy();
  });

  it("does NOT mark a floor when every model call reported", () => {
    const { container } = draw({
      durationMs: 2000,
      usage: { requests: 3, reported_requests: 3, input_tokens: 900, output_tokens: 120 },
      tools: [],
    });
    expect(container.textContent).not.toContain("≥");
  });

  it("renders a turn whose ONLY measurement is its model calls", () => {
    // No duration, no tools, no tokens — the row must still appear rather than
    // collapsing to nothing, because a model call did happen.
    const { container } = draw({ durationMs: null, usage: { requests: 2 }, tools: [] });
    expect(container.textContent).toContain("2 model calls");
  });
});
