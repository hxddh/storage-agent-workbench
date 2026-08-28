import { describe, expect, it } from "vitest";
import { nextTurnIndex } from "./threadNavigation";

describe("nextTurnIndex", () => {
  const turns = [0, 900, 1800, 2700, 3600, 4500, 5400];

  it("moves one exchange backward from the end of a long thread", () => {
    expect(nextTurnIndex(turns, 5676, -1)).toBe(5);
  });

  it("moves forward again after the previous turn has been aligned near the top", () => {
    // The current turn can land tens of pixels below the container's exact top;
    // the old 4px viewport heuristic selected it again instead of advancing.
    expect(nextTurnIndex(turns, 4460, 1)).toBe(6);
  });

  it("clamps at both ends", () => {
    expect(nextTurnIndex(turns, 0, -1)).toBe(0);
    expect(nextTurnIndex(turns, 6000, 1)).toBe(6);
  });

  it("returns null when there is no conversation to navigate", () => {
    expect(nextTurnIndex([], 0, 1)).toBeNull();
  });
});
