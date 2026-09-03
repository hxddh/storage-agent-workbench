import type { TFunc } from "../i18n";
import type { TokenUsage } from "../types";

/**
 * One usage vocabulary for the whole window (v1.15).
 *
 * Three surfaces used to disagree: Execution detail joined in/out/cached as
 * parallel parts (cached is a SUBSET of input, so users summed it twice),
 * the Composer meter vanished when the window was unknown, and two different
 * `k` formatters rounded the same turn to two numbers. This module is the
 * single source: one formatter, one floor rule, cached-as-subset, and an
 * explicit unreported state instead of a vanishing meter.
 */

/** Single token formatter: 12_400 → "12k", 900 → "900", null → "—". */
export function fmtTokensUnified(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/** True when only some of the turn's model calls reported usage. */
export function isUsageFloor(usage: TokenUsage | null | undefined): boolean {
  if (!usage) return false;
  const total = usage.requests;
  const reported = usage.reported_requests;
  return (
    typeof total === "number" &&
    typeof reported === "number" &&
    Number.isFinite(total) &&
    Number.isFinite(reported) &&
    reported > 0 &&
    reported < total
  );
}

/** True when the endpoint reported nothing token-shaped at all. */
export function isUsageUnreported(usage: TokenUsage | null | undefined): boolean {
  if (!usage) return true;
  return (
    usage.input_tokens == null &&
    usage.output_tokens == null &&
    usage.total_tokens == null
  );
}

function totalOf(usage: TokenUsage): number | null {
  if (usage.total_tokens != null) return usage.total_tokens;
  if (usage.input_tokens != null || usage.output_tokens != null) {
    return (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
  }
  return null;
}

/** Extra turn facts the backend persists beside tokens (v1.16). */
export type UsageExtras = {
  budget_tokens?: number | null;
  repeat_calls_avoided?: number | null;
};

/**
 * One line for an execution's spend. Cached renders as a subset
 * ("incl. X cached"), never as an additive part. A floor renders with a `~`
 * prefix; the caller puts the floor reason in the title/tooltip.
 * v1.16 also names the turn governor (budget) and memory reuse — both were
 * persisted for releases and never painted, so capped turns looked broken.
 */
export function formatUsageLine(usage: (TokenUsage & UsageExtras) | null | undefined, t: TFunc): string | null {
  if (!usage || isUsageUnreported(usage)) return null;
  const parts: string[] = [];
  if (usage.input_tokens != null) parts.push(t("usage.in", { n: fmtTokensUnified(usage.input_tokens) }));
  if (usage.output_tokens != null) parts.push(t("usage.out", { n: fmtTokensUnified(usage.output_tokens) }));
  const total = totalOf(usage);
  if (total != null) parts.push(t("usage.total", { n: fmtTokensUnified(total) }));
  // Cached is part of input — "of which", never a sibling to sum.
  if (usage.cached_input_tokens != null) parts.push(t("usage.cachedOf", { n: fmtTokensUnified(usage.cached_input_tokens) }));
  if (usage.reasoning_tokens != null) parts.push(t("usage.reasoning", { n: fmtTokensUnified(usage.reasoning_tokens) }));
  if (usage.requests != null && usage.requests > 0) parts.push(t("usage.requests", { n: usage.requests }));
  if (usage.budget_tokens != null) parts.push(t("usage.budget", { n: fmtTokensUnified(usage.budget_tokens) }));
  if (usage.repeat_calls_avoided != null && usage.repeat_calls_avoided > 0) {
    parts.push(t("usage.reused", { n: usage.repeat_calls_avoided }));
  }
  if (!parts.length) return null;
  const text = parts.join(" · ");
  return isUsageFloor(usage) ? t("usage.floor", { text: `~${text}` }) : text;
}

/** Tooltip for a usage line (v1.16): same notes as the Composer meter —
 * the floor reason when partial, always the one-time-steps disclosure. */
export function usageTitle(usage: TokenUsage | null | undefined, t: TFunc): string | undefined {
  if (!usage) return undefined;
  const notes = [t("usage.systemNote")];
  if (isUsageFloor(usage)) {
    notes.push(t("usage.floorHint", {
      reported: usage.reported_requests ?? 0,
      total: usage.requests ?? 0,
    }));
  }
  return notes.join(" ");
}

export type ContextReading =
  | { kind: "none" }
  | { kind: "unreported" }
  | { kind: "measured"; used: number; window: number; pct: number; floor: boolean; estimated: boolean; windowSource: string | null };

/**
 * The Composer meter reading. `none` (fresh task, no metrics yet) paints
 * nothing. `unreported` paints a quiet badge — vanishing was the lie.
 * `measured` paints the ring; `estimated` marks a post-compaction estimate.
 */
export function contextReading(
  metrics: { usage?: TokenUsage | null; total_tokens?: number | null; input_tokens?: number | null; output_tokens?: number | null; context_window?: number | null; context_window_source?: string | null } | null | undefined,
  compactedTokens: number | null = null,
): ContextReading {
  if (!metrics) return { kind: "none" };
  const window = (metrics as { context_window?: number | null }).context_window;
  const estimated = compactedTokens != null && Number.isFinite(compactedTokens);
  const usage = metrics.usage ?? metrics;
  const used = estimated
    ? (compactedTokens as number)
    : (usage.total_tokens ??
      (usage.input_tokens != null || usage.output_tokens != null
        ? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)
        : (metrics.total_tokens ??
          ((metrics.input_tokens ?? 0) + (metrics.output_tokens ?? 0) || null as unknown as number))));
  if (typeof window !== "number" || !Number.isFinite(window) || window <= 0) return { kind: "unreported" };
  if (typeof used !== "number" || !Number.isFinite(used) || used <= 0) return { kind: "unreported" };
  return {
    kind: "measured",
    used,
    window,
    pct: Math.min(100, Math.max(0, Math.round((used / window) * 100))),
    floor: isUsageFloor(usage),
    estimated,
    windowSource: (metrics as { context_window_source?: string | null }).context_window_source ?? null,
  };
}
