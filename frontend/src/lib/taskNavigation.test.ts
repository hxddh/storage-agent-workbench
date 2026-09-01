import { describe, expect, it } from "vitest";
import {
  currentTaskStepIndex,
  nextTaskStepIndex,
  stepTaskIndex,
  taskStepScrollTop,
  TASK_STEP_SCROLL_MARGIN,
} from "./taskNavigation";

describe("task step navigation", () => {
  const turns = [0, 900, 1800, 2700, 3600, 4500, 5400];

  it("infers the current exchange from a reading anchor", () => {
    expect(currentTaskStepIndex(turns, 4460)).toBe(5);
  });

  it("moves one exchange backward from the end of a long task", () => {
    expect(nextTaskStepIndex(turns, 5676, -1)).toBe(5);
  });

  it("uses a semantic cursor for the reverse step, independent of scroll geometry", () => {
    const previous = nextTaskStepIndex(turns, 5676, -1);
    expect(previous).toBe(5);
    expect(stepTaskIndex(previous!, turns.length, 1)).toBe(6);
  });

  it("clamps at both ends", () => {
    expect(stepTaskIndex(0, turns.length, -1)).toBe(0);
    expect(stepTaskIndex(6, turns.length, 1)).toBe(6);
  });

  it("returns null when there is no Task to navigate", () => {
    expect(currentTaskStepIndex([], 0)).toBeNull();
    expect(nextTaskStepIndex([], 0, 1)).toBeNull();
    expect(stepTaskIndex(0, 0, 1)).toBeNull();
  });

  it("aligns a Direction to the reading start, including at the document origin", () => {
    expect(taskStepScrollTop(900)).toBe(900 - TASK_STEP_SCROLL_MARGIN);
    expect(taskStepScrollTop(40)).toBe(0);
  });
});
