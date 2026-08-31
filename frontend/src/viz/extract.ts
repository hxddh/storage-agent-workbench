import type {
  AccessChart,
  AnalysisDocument,
  CostChart,
  DistChart,
  DriftChart,
  HorizonPoint,
} from "./types";

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Discrete simulator horizons only. Never invent a day the runtime did not emit. */
export function costChart(doc: AnalysisDocument | null | undefined): CostChart | null {
  if (!doc) return null;
  const payload = record(doc.document);
  if (!payload) return null;
  const gaps = Array.isArray(payload.gaps)
    ? payload.gaps.map((item) => {
        const row = record(item) ?? {};
        return { code: str(row.code) ?? undefined, message: str(row.message) ?? undefined };
      })
    : [];
  if (payload.kind === "gap" || (!Array.isArray(payload.timeline) && gaps.length)) {
    return {
      kind: "cost",
      estimate: true,
      priceConfirmed: false,
      coverage: doc.coverage,
      gaps: gaps.length ? gaps : [{ code: str(payload.code) ?? "gap" }],
      horizons: [],
      delta: null,
      classes: [],
    };
  }
  const timeline = Array.isArray(payload.timeline) ? payload.timeline : [];
  const horizons: HorizonPoint[] = [];
  const classSet = new Set<string>();
  for (const raw of timeline) {
    const point = record(raw);
    if (!point || num(point.day) == null) continue;
    const candidate = record(point.candidate_class_bytes) ?? {};
    const classes: Record<string, number> = {};
    for (const [name, bytes] of Object.entries(candidate)) {
      const amount = num(bytes);
      if (amount == null) continue;
      classes[name] = amount;
      classSet.add(name);
    }
    const candidateCost = record(point.candidate_monthly_cost);
    const baselineCost = record(point.baseline_monthly_cost);
    horizons.push({
      day: num(point.day) as number,
      classes,
      baselineCost: candidateCost ? num(baselineCost?.usd_per_month) : (baselineCost ? num(baselineCost.usd_per_month) : null),
      candidateCost: candidateCost ? num(candidateCost.usd_per_month) : null,
    });
  }
  const delta = record(payload.monthly_cost_delta);
  const priceConfirmed = horizons.some((h) => h.candidateCost != null);
  return {
    kind: "cost",
    estimate: true,
    priceConfirmed,
    coverage: doc.coverage,
    gaps,
    horizons,
    delta: delta ? num(delta.usd_per_month_at_365d) : null,
    classes: [...classSet],
  };
}

export function inventoryChart(doc: AnalysisDocument | null | undefined): DistChart | null {
  if (!doc) return null;
  const payload = record(doc.document);
  if (!payload) return null;
  const ageRaw = Array.isArray(payload.object_age_distribution) ? payload.object_age_distribution : [];
  const classRaw = Array.isArray(payload.storage_class_distribution) ? payload.storage_class_distribution : [];
  const age = ageRaw.flatMap((item) => {
    const row = record(item);
    if (!row) return [];
    const label = str(row.bucket) ?? str(row.value);
    const count = num(row.count);
    if (!label || count == null) return [];
    return [{ label, count, size: num(row.size) }];
  });
  const storageClass = classRaw.flatMap((item) => {
    const row = record(item);
    if (!row) return [];
    const label = str(row.value) ?? str(row.bucket);
    const count = num(row.count);
    if (!label || count == null) return [];
    return [{ label, count, size: num(row.size) }];
  });
  if (age.length === 0 && storageClass.length === 0 && num(payload.object_count) == null) return null;
  return {
    kind: "distribution",
    estimate: Boolean(doc.coverage?.truncated) || (doc.coverage?.unknown_age_ratio ?? 0) > 0,
    coverage: doc.coverage,
    age,
    storageClass,
    jointObserved: false,
  };
}

export function driftChart(doc: AnalysisDocument | null | undefined): DriftChart | null {
  if (!doc) return null;
  const payload = record(doc.document);
  if (!payload) return null;
  if (payload.kind === "gap") {
    return {
      kind: "drift",
      estimate: true,
      coverage: doc.coverage,
      gap: str(payload.message) ?? str(payload.code) ?? "no_baseline",
      added: 0,
      resolved: 0,
      stillPresent: 0,
      objectDelta: null,
      sizeDelta: null,
      trendNote: null,
    };
  }
  const findings = record(payload.findings) ?? {};
  const added = Array.isArray(findings.added) ? findings.added.length : 0;
  const resolved = Array.isArray(findings.resolved) ? findings.resolved.length : 0;
  const stillPresent = Array.isArray(findings.still_present) ? findings.still_present.length : 0;
  const trend = record(payload.inventory_trend);
  return {
    kind: "drift",
    estimate: payload.estimate === true || Boolean(trend?.estimate),
    coverage: doc.coverage,
    gap: null,
    added,
    resolved,
    stillPresent,
    objectDelta: trend ? num(trend.object_count_delta) : null,
    sizeDelta: trend ? num(trend.total_size_delta) : null,
    trendNote: trend ? str(trend.note) : null,
  };
}

export function accessChart(doc: AnalysisDocument | null | undefined): AccessChart | null {
  if (!doc) return null;
  const payload = record(doc.document);
  if (!payload) return null;
  const latencyRaw = record(payload.latency);
  const latency = latencyRaw && num(latencyRaw.measured_requests)
    ? {
        p50: num(latencyRaw.p50_ms) ?? 0,
        p95: num(latencyRaw.p95_ms) ?? 0,
        p99: num(latencyRaw.p99_ms) ?? 0,
        max: num(latencyRaw.max_ms) ?? 0,
        measured: num(latencyRaw.measured_requests) as number,
      }
    : null;
  const methods = (Array.isArray(payload.method_distribution) ? payload.method_distribution : []).flatMap((item) => {
    const row = record(item);
    if (!row) return [];
    const label = str(row.value);
    const count = num(row.count);
    if (!label || count == null) return [];
    return [{ label, count }];
  });
  const statuses = (Array.isArray(payload.status_code_distribution) ? payload.status_code_distribution : []).flatMap((item) => {
    const row = record(item);
    if (!row) return [];
    const label = str(row.value);
    const count = num(row.count);
    if (!label || count == null) return [];
    return [{ label, count }];
  });
  if (!latency && methods.length === 0 && statuses.length === 0 && num(payload.total_requests) == null) return null;
  return {
    kind: "access",
    estimate: Boolean(doc.coverage?.truncated) || (doc.coverage?.parsed_fraction != null && doc.coverage.parsed_fraction < 1),
    coverage: doc.coverage,
    latency,
    methods,
    statuses,
  };
}
