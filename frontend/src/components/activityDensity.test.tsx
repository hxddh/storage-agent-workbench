import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { I18nProvider } from "../i18n";
import {
  defaultTraceOpen,
  getActivityDensity,
  setActivityDensity,
} from "../lib/activityDensity";
import { ExecutionSummary } from "./ExecutionSummary";
import type { ToolActivity } from "../types";

const tools: ToolActivity[] = [
  { id: "c1", tool: "head_bucket", target: "acme-logs", result: "200", ok: true },
];

const wrap = (node: React.ReactNode) => render(createElement(I18nProvider, null, node));

afterEach(() => {
  cleanup();
  setActivityDensity("balanced");
});

describe("Agent execution detail density", () => {
  it("has explicit disclosure semantics rather than cosmetic labels", () => {
    expect(defaultTraceOpen("compact", true)).toBe(false);
    expect(defaultTraceOpen("balanced", true)).toBe(true);
    expect(defaultTraceOpen("balanced", false)).toBe(false);
    expect(defaultTraceOpen("detailed", false)).toBe(true);
  });

  it("compact keeps even the newest completed execution folded", () => {
    setActivityDensity("compact");
    wrap(createElement(ExecutionSummary, { tools, latest: true }));
    expect(screen.queryByText("head_bucket")).not.toBeNull();
    expect(screen.getByTestId("execution-summary")).toHaveAttribute("data-activity-density", "compact");
    expect(screen.queryByTestId("execution-step-open")).toBeNull();
    expect(screen.getByTestId("execution-latest-step")).toHaveTextContent("head_bucket");
  });

  it("balanced keeps the newest execution open and history folded", () => {
    setActivityDensity("balanced");
    const { rerender } = wrap(createElement(ExecutionSummary, { tools, latest: true }));
    expect(screen.getByTestId("execution-step-open")).toBeInTheDocument();
    rerender(createElement(I18nProvider, null, createElement(ExecutionSummary, { tools, latest: false })));
    expect(screen.queryByTestId("execution-step-open")).toBeNull();
  });

  it("detailed keeps historical completed execution visible", () => {
    setActivityDensity("detailed");
    wrap(createElement(ExecutionSummary, { tools, latest: false }));
    expect(screen.getByTestId("execution-step-open")).toBeInTheDocument();
  });

  it("changes density from the newest result and persists the preference", () => {
    setActivityDensity("balanced");
    wrap(createElement(ExecutionSummary, { tools, latest: true }));
    fireEvent.click(screen.getByTestId("activity-density-control").querySelector("button") as HTMLButtonElement);
    fireEvent.click(screen.getByRole("menuitemradio", { name: /compact/i }));
    expect(getActivityDensity()).toBe("compact");
    expect(localStorage.getItem("saw.activityDensity")).toBe("compact");
    expect(screen.queryByTestId("execution-step-open")).toBeNull();
    expect(screen.getByTestId("execution-latest-step")).toHaveTextContent("head_bucket");
  });

  it("an explicit override still drills into execution evidence in compact mode", () => {
    setActivityDensity("compact");
    wrap(createElement(ExecutionSummary, { tools, latest: true }));
    fireEvent.click(screen.getByTestId("execution-summary-toggle"));
    expect(screen.getByTestId("execution-step-open")).toBeInTheDocument();
  });
});
