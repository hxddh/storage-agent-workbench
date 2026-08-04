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
import { TurnMetricsBar, fmtDuration, fmtTokens } from "./TurnMetrics";
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
});
