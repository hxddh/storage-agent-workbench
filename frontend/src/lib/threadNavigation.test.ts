import { describe, expect, it } from "vitest";
import { currentTurnIndex, nextTurnIndex, stepTurnIndex } from "./threadNavigation";

describe("thread navigation", () => {
  const turns = [0, 900, 1800, 2700, 3600, 4500, 5400];

  it("infers the current exchange from a reading anchor", () => {
    expect(currentTurnIndex(turns, 4460)).toBe(5);
  });

  it("moves one exchange backward from the end of a long thread", () => {
    expect(nextTurnIndex(turns, 5676, -1)).toBe(5);
  });

  it("uses a semantic cursor for the reverse step, independent of scroll geometry", () => {
    const previous = nextTurnIndex(turns, 5676, -1);
    expect(previous).toBe(5);
    expect(stepTurnIndex(previous!, turns.length, 1)).toBe(6);
  });

  it("clamps at both ends", () => {
    expect(stepTurnIndex(0, turns.length, -1)).toBe(0);
    expect(stepTurnIndex(6, turns.length, 1)).toBe(6);
  });

  it("returns null when there is no conversation to navigate", () => {
    expect(currentTurnIndex([], 0)).toBeNull();
    expect(nextTurnIndex([], 0, 1)).toBeNull();
    expect(stepTurnIndex(0, 0, 1)).toBeNull();
  });
});
