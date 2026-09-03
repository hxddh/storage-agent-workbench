import { describe, expect, it } from "vitest";
import { localDayKey, previousDayKey, timeAgo } from "./time";
import type { TFunc } from "../i18n";

const t = ((key: string, vars?: Record<string, number>) => {
  const table: Record<string, string> = {
    "time.now": "now",
    "time.mAgo": `${vars?.n}m ago`,
    "time.hAgo": `${vars?.n}h ago`,
    "time.yesterday": "yesterday",
    "time.dAgo": `${vars?.n}d ago`,
    "time.wAgo": `${vars?.n}w ago`,
  };
  return table[key] ?? key;
}) as TFunc;

describe("shared relative time", () => {
  it("reads seconds through weeks", () => {
    const now = Date.now();
    expect(timeAgo(new Date(now - 10_000).toISOString(), t)).toBe("now");
    expect(timeAgo(new Date(now - 5 * 60_000).toISOString(), t)).toBe("5m ago");
    expect(timeAgo(new Date(now - 3 * 3_600_000).toISOString(), t)).toBe("3h ago");
    expect(timeAgo("not-a-date", t)).toBe("");
  });

  it("steps back one calendar day across DST, not 24h of milliseconds", () => {
    // 2026-03-08 is a US DST spring-forward day (23 hours). Calendar math
    // still lands on March 7; millisecond math would land mid-day either way
    // here, but on fall-back (25h) days -86_400_000 lands on the wrong date.
    const nov2 = new Date(2025, 10, 2, 12).getTime();
    expect(new Date(previousDayKey(localDayKey(nov2))).getDate()).toBe(1);
    expect(previousDayKey(localDayKey(nov2))).toBeLessThan(localDayKey(nov2));
  });
});
