import { useI18n } from "../i18n";
import { useSessionRun } from "../sessionRuns";
import { useActiveTaskId } from "../agent/activeTask";
import type { ExecutionMetrics } from "../types";

/**
 * How much of the model's context window the last Execution used. Painted
 * only when the runtime reported BOTH a usage figure and the window it ran
 * under (`metrics.context_window`); with either missing nothing is drawn —
 * a meter with a guessed denominator would be a made-up number.
 */
export function contextUsage(
  metrics: ExecutionMetrics | null | undefined,
  /** Tokens left after a compaction (v1.12) — replaces the usage figure until
   * the next execution reports its own. The window still has to be real. */
  compactedTokens: number | null = null,
): { used: number; window: number; pct: number } | null {
  if (!metrics) return null;
  const window = (metrics as { context_window?: number | null }).context_window;
  if (typeof window !== "number" || !Number.isFinite(window) || window <= 0) return null;
  const used = compactedTokens != null && Number.isFinite(compactedTokens) ? compactedTokens
    : metrics.usage?.total_tokens ?? metrics.total_tokens
    ?? ((metrics.usage?.input_tokens ?? metrics.input_tokens ?? 0) + (metrics.usage?.output_tokens ?? metrics.output_tokens ?? 0));
  if (typeof used !== "number" || !Number.isFinite(used) || used <= 0) return null;
  return { used, window, pct: Math.min(100, Math.max(0, Math.round((used / window) * 100))) };
}

const RADIUS = 5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const formatTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n));

export function ContextMeter() {
  const { lang } = useI18n();
  const taskId = useActiveTaskId();
  const run = useSessionRun(taskId);
  const usage = contextUsage(run.lastMetrics?.metrics, run.contextTokens);
  if (!usage) return null;
  const title = lang === "zh"
    ? `上下文已用 ${usage.pct}%（${formatTokens(usage.used)} / ${formatTokens(usage.window)} tokens）`
    : `${usage.pct}% of context used (${formatTokens(usage.used)} of ${formatTokens(usage.window)} tokens)`;
  return (
    <span className="native-context-meter" data-testid="context-meter" data-pct={usage.pct} title={title} aria-label={title} role="img">
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
        <circle cx="7" cy="7" r={RADIUS} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
        <circle
          cx="7" cy="7" r={RADIUS} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - usage.pct / 100)}
          transform="rotate(-90 7 7)"
        />
      </svg>
      <span>{usage.pct}%</span>
    </span>
  );
}
