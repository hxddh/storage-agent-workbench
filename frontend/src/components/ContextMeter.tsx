import { useI18n } from "../i18n";
import { useSessionRun } from "../sessionRuns";
import { useActiveTaskId } from "../agent/activeTask";
import type { ExecutionMetrics } from "../types";
import { contextReading, fmtTokensUnified } from "../lib/usage";

/**
 * How much of the model's context window the last Execution used (v1.15).
 *
 * One vocabulary with Execution detail (`lib/usage`): a fresh task paints
 * nothing; an endpoint that stayed silent paints a quiet "not reported"
 * badge instead of vanishing; a post-compaction estimate is marked as an
 * estimate. The denominator is always the runtime-reported window — never a
 * guessed one.
 */
export function contextUsage(
  metrics: ExecutionMetrics | null | undefined,
  compactedTokens: number | null = null,
): { used: number; window: number; pct: number } | null {
  const reading = contextReading(metrics, compactedTokens);
  if (reading.kind !== "measured") return null;
  return { used: reading.used, window: reading.window, pct: reading.pct };
}

const RADIUS = 5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function ContextMeter() {
  const { lang, t } = useI18n();
  const taskId = useActiveTaskId();
  const run = useSessionRun(taskId);
  if (!run.lastMetrics?.metrics && run.contextTokens == null) return null;
  const reading = contextReading(run.lastMetrics?.metrics, run.contextTokens);
  if (reading.kind === "none") return null;
  if (reading.kind === "unreported") {
    const label = t("usage.unreported");
    return (
      <span className="native-context-meter" data-testid="context-meter" data-state="unreported" title={t("usage.unreportedHint")} aria-label={label} role="img">
        <span aria-hidden>·</span>
        <span>{label}</span>
      </span>
    );
  }
  const est = reading.estimated ? ` ${t("usage.estimated")}` : "";
  const floor = reading.floor ? "~" : "";
  const title = lang === "zh"
    ? `上下文已用 ${reading.pct}%（${floor}${fmtTokensUnified(reading.used)} / ${fmtTokensUnified(reading.window)} tokens${est}）`
    : `${floor}${reading.pct}% of context used (${fmtTokensUnified(reading.used)} of ${fmtTokensUnified(reading.window)} tokens${est})`;
  const fullTitle = reading.floor
    ? `${title} — ${t("usage.floorHint", { reported: (run.lastMetrics?.metrics?.usage?.reported_requests ?? run.lastMetrics?.metrics?.reported_requests ?? 0), total: (run.lastMetrics?.metrics?.usage?.requests ?? run.lastMetrics?.metrics?.requests ?? 0) })}`
    : reading.estimated
      ? `${title} — ${t("usage.estimatedHint")}`
      : title;
  return (
    <span className="native-context-meter" data-testid="context-meter" data-pct={reading.pct} data-estimated={reading.estimated ? "true" : "false"} data-floor={reading.floor ? "true" : "false"} title={fullTitle} aria-label={title} role="img">
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
        <circle cx="7" cy="7" r={RADIUS} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
        <circle
          cx="7" cy="7" r={RADIUS} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - reading.pct / 100)}
          transform="rotate(-90 7 7)"
        />
      </svg>
      <span>{floor}{reading.pct}%{reading.estimated ? "*" : ""}</span>
    </span>
  );
}
