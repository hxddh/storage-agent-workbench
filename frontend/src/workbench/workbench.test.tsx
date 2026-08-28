import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SurfaceTabs } from "./SurfaceTabs";
import { initialWorkbenchState, workbenchReducer } from "./model";

afterEach(cleanup);

describe("Agent OS work surfaces", () => {
  it("starts in the timeline rather than a modal or dashboard", () => {
    expect(initialWorkbenchState("s1")).toEqual({
      surface: "timeline",
      mode: "workspace",
      selectedRunId: null,
      sessionId: "s1",
    });
  });

  it("cannot open investigation surfaces before an investigation exists", () => {
    const state = initialWorkbenchState(null);
    expect(workbenchReducer(state, { type: "surface.open", surface: "evidence" })).toBe(state);
  });

  it("a new blank investigation always returns to the timeline", () => {
    const evidence = workbenchReducer(initialWorkbenchState("s1"), { type: "surface.open", surface: "evidence" });
    const blank = workbenchReducer(evidence, { type: "session.changed", sessionId: null });
    expect(blank.surface).toBe("timeline");
    expect(blank.selectedRunId).toBeNull();
  });

  it("a run is a first-class Runs surface selection", () => {
    const next = workbenchReducer(initialWorkbenchState("s1"), { type: "run.open", runId: "run-9" });
    expect(next.surface).toBe("runs");
    expect(next.selectedRunId).toBe("run-9");
  });

  it("exposes real tabs and disables session-bound surfaces on a blank investigation", () => {
    render(<SurfaceTabs active="timeline" sessionReady={false} onChange={() => undefined} />);
    expect(screen.getByRole("tab", { name: "Timeline" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Evidence" })).toBeDisabled();
    expect(screen.getByRole("tab", { name: "Runs" })).toBeDisabled();
    expect(screen.getByRole("tab", { name: "Report" })).toBeDisabled();
  });

  it("arrow keys move between work surfaces instead of trapping focus in chrome", () => {
    const onChange = vi.fn();
    render(<SurfaceTabs active="evidence" sessionReady onChange={onChange} />);
    const evidence = screen.getByRole("tab", { name: "Evidence" });
    evidence.focus();
    fireEvent.keyDown(evidence.parentElement as HTMLElement, { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("runs");
  });
});
