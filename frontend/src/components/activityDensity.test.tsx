import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { I18nProvider } from "../i18n";
import {
  defaultTraceOpen,
  getActivityDensity,
  setActivityDensity,
} from "../lib/activityDensity";
import { TurnFooter } from "./TurnFooter";
import type { ToolActivity } from "../types";

const tools: ToolActivity[] = [
  { id: "c1", tool: "head_bucket", target: "acme-logs", result: "200", ok: true },
];

const wrap = (node: React.ReactNode) => render(createElement(I18nProvider, null, node));

afterEach(() => {
  cleanup();
  setActivityDensity("balanced");
});

describe("agent activity density", () => {
  it("has explicit disclosure semantics rather than three cosmetic labels", () => {
    expect(defaultTraceOpen("compact", true)).toBe(false);
    expect(defaultTraceOpen("balanced", true)).toBe(true);
    expect(defaultTraceOpen("balanced", false)).toBe(false);
    expect(defaultTraceOpen("detailed", false)).toBe(true);
  });

  it("compact keeps even the newest finished trace folded", () => {
    setActivityDensity("compact");
    wrap(createElement(TurnFooter, { tools, latest: true }));
    expect(screen.queryByText("head_bucket")).toBeNull();
    expect(screen.getByTestId("turn-activity")).toHaveAttribute("data-activity-density", "compact");
  });

  it("balanced preserves the existing newest-open/history-folded contract", () => {
    setActivityDensity("balanced");
    const { rerender } = wrap(createElement(TurnFooter, { tools, latest: true }));
    expect(screen.getByText("head_bucket")).toBeInTheDocument();
    rerender(createElement(I18nProvider, null, createElement(TurnFooter, { tools, latest: false })));
    expect(screen.queryByText("head_bucket")).toBeNull();
  });

  it("detailed keeps a historical finished trace visible", () => {
    setActivityDensity("detailed");
    wrap(createElement(TurnFooter, { tools, latest: false }));
    expect(screen.getByText("head_bucket")).toBeInTheDocument();
  });

  it("changes density from the newest turn and persists the preference", () => {
    setActivityDensity("balanced");
    wrap(createElement(TurnFooter, { tools, latest: true }));
    fireEvent.click(screen.getByTestId("activity-density-control").querySelector("button") as HTMLButtonElement);
    fireEvent.click(screen.getByRole("menuitemradio", { name: /compact/i }));
    expect(getActivityDensity()).toBe("compact");
    expect(localStorage.getItem("saw.activityDensity")).toBe("compact");
    expect(screen.queryByText("head_bucket")).toBeNull();
  });

  it("an explicit turn override still drills into evidence in compact mode", () => {
    setActivityDensity("compact");
    wrap(createElement(TurnFooter, { tools, latest: true }));
    fireEvent.click(screen.getByTestId("turn-footer-toggle"));
    expect(screen.getByText("head_bucket")).toBeInTheDocument();
  });
});
