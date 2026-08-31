import { describe, expect, it } from "vitest";
import { accessChart, costChart, driftChart, inventoryChart } from "./extract";
import type { AnalysisDocument } from "./types";

const wrap = (document: Record<string, unknown>, coverage: AnalysisDocument["coverage"] = null): AnalysisDocument => ({
  tool: "t",
  call_id: "c",
  document,
  coverage,
});

describe("costChart", () => {
  it("renders an explicit gap when there is no inventory", () => {
    const chart = costChart(wrap({ kind: "gap", gaps: [{ code: "no_inventory", message: "Attach inventory." }], timeline: [] }));
    expect(chart?.horizons).toEqual([]);
    expect(chart?.gaps[0]?.code).toBe("no_inventory");
    expect(chart?.priceConfirmed).toBe(false);
    expect(chart?.delta).toBeNull();
  });

  it("withholds the cost axis when prices are unconfirmed", () => {
    const chart = costChart(wrap({
      kind: "simulation",
      gaps: [{ code: "price_unconfirmed" }],
      timeline: [
        { day: 0, candidate_class_bytes: { STANDARD: 10 }, candidate_monthly_cost: null, baseline_monthly_cost: null },
      ],
      monthly_cost_delta: null,
    }));
    expect(chart?.horizons).toHaveLength(1);
    expect(chart?.horizons[0].classes.STANDARD).toBe(10);
    expect(chart?.horizons[0].candidateCost).toBeNull();
    expect(chart?.priceConfirmed).toBe(false);
    expect(chart?.delta).toBeNull();
  });

  it("plots only emitted horizons — a single point is a single point", () => {
    const chart = costChart(wrap({
      kind: "simulation",
      timeline: [
        {
          day: 0,
          candidate_class_bytes: { STANDARD: 100 },
          candidate_monthly_cost: { usd_per_month: 2.3 },
          baseline_monthly_cost: { usd_per_month: 2.3 },
        },
      ],
      monthly_cost_delta: { usd_per_month_at_365d: 0, estimate: true },
    }));
    expect(chart?.horizons.map((h) => h.day)).toEqual([0]);
    expect(chart?.delta).toBe(0);
    expect(chart?.priceConfirmed).toBe(true);
  });

  it("does not invent a day between 0 and 365", () => {
    const chart = costChart(wrap({
      kind: "simulation",
      timeline: [
        { day: 0, candidate_class_bytes: { STANDARD: 100 }, candidate_monthly_cost: { usd_per_month: 2 } },
        { day: 365, candidate_class_bytes: { STANDARD_IA: 100 }, candidate_monthly_cost: { usd_per_month: 1 } },
      ],
      monthly_cost_delta: { usd_per_month_at_365d: -1, estimate: true },
    }));
    expect(chart?.horizons.map((h) => h.day)).toEqual([0, 365]);
  });

  it("ignores non-numeric class bytes instead of interpolating them", () => {
    const chart = costChart(wrap({
      kind: "simulation",
      timeline: [{ day: 0, candidate_class_bytes: { STANDARD: "n/a", GLACIER: 4 } }],
    }));
    expect(chart?.horizons[0].classes).toEqual({ GLACIER: 4 });
    expect(chart?.classes).toEqual(["GLACIER"]);
  });
});

describe("inventoryChart", () => {
  it("is empty-safe", () => {
    expect(inventoryChart(wrap({}))).toBeNull();
  });

  it("plots independent age and class distributions, never a joint matrix", () => {
    const chart = inventoryChart(wrap({
      object_count: 3,
      object_age_distribution: [{ bucket: "0-7d", count: 1 }, { bucket: "365d+", count: 2 }],
      storage_class_distribution: [{ value: "STANDARD", count: 3, size: 9 }],
    }));
    expect(chart?.jointObserved).toBe(false);
    expect(chart?.age).toHaveLength(2);
    expect(chart?.storageClass[0]).toEqual({ label: "STANDARD", count: 3, size: 9 });
  });

  it("drops buckets with no count rather than filling zeros", () => {
    const chart = inventoryChart(wrap({
      object_age_distribution: [{ bucket: "0-7d" }, { bucket: "8-30d", count: 4 }],
    }));
    expect(chart?.age).toEqual([{ label: "8-30d", count: 4, size: null }]);
  });
});

describe("driftChart", () => {
  it("surfaces a missing baseline as a gap", () => {
    const chart = driftChart(wrap({ kind: "gap", code: "no_baseline", message: "No comparable baseline exists." }));
    expect(chart?.gap).toMatch(/baseline/i);
    expect(chart?.objectDelta).toBeNull();
  });

  it("counts the three finding classes without inventing a trend", () => {
    const chart = driftChart(wrap({
      kind: "drift",
      estimate: true,
      findings: { added: [{ title: "a" }], resolved: [], still_present: [{ title: "b" }, { title: "c" }] },
      inventory_trend: { object_count_delta: 2, total_size_delta: 50, points: 2, note: "Two snapshots only.", estimate: true },
    }));
    expect(chart?.added).toBe(1);
    expect(chart?.stillPresent).toBe(2);
    expect(chart?.objectDelta).toBe(2);
    expect(chart?.trendNote).toMatch(/Two snapshots/);
  });
});

describe("accessChart", () => {
  it("treats absent latency as a gap, not zero", () => {
    const chart = accessChart(wrap({
      total_requests: 10,
      method_distribution: [{ value: "GET", count: 10 }],
      latency: null,
    }));
    expect(chart?.latency).toBeNull();
    expect(chart?.methods).toEqual([{ label: "GET", count: 10 }]);
  });

  it("keeps percentile extremes as emitted", () => {
    const chart = accessChart(wrap({
      latency: { measured_requests: 3, p50_ms: 1, p95_ms: 9, p99_ms: 99, max_ms: 1000 },
    }));
    expect(chart?.latency).toEqual({ measured: 3, p50: 1, p95: 9, p99: 99, max: 1000 });
  });
});
