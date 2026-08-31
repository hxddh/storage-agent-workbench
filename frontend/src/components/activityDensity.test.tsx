import { afterEach, describe, expect, it } from "vitest";
import {
  defaultTraceOpen,
  getActivityDensity,
  setActivityDensity,
} from "../lib/activityDensity";

afterEach(() => {
  setActivityDensity("balanced");
});

describe("Agent execution detail density helpers", () => {
  it("has explicit disclosure semantics rather than cosmetic labels", () => {
    expect(defaultTraceOpen("compact", true)).toBe(false);
    expect(defaultTraceOpen("balanced", true)).toBe(true);
    expect(defaultTraceOpen("balanced", false)).toBe(false);
    expect(defaultTraceOpen("detailed", false)).toBe(true);
  });

  it("round-trips the stored density preference", () => {
    setActivityDensity("compact");
    expect(getActivityDensity()).toBe("compact");
    expect(localStorage.getItem("saw.activityDensity")).toBe("compact");
    setActivityDensity("detailed");
    expect(getActivityDensity()).toBe("detailed");
  });
});
