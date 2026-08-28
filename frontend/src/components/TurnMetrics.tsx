import { useMemo, useState } from "react";
import { useI18n } from "../i18n";
import type { ToolActivity, TokenUsage } from "../types";

/** Format a duration the way a person reads a wait: sub-second in ms, seconds
 * with one decimal, longer spans in m/s. Never scientific, never bare ms for a
 * two-minute turn. */
export function fmtDuration(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

/** Compact token counts. Exact below 1000 — rounding "812" to "0.8k" would
 * hide precision the provider actually gave us. */
export function fmtTokens(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n) || n < 0) return null;
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function countByTool(tools: ToolActivity[]): { tool: string; n: number; errs: number }[] {
  const map = new Map<string, { tool: string; n: number; errs: number }>();
  for (const a of tools) {
    if (a.status === "started") continue; // in-flight, not yet a completed call
    const row = map.get(a.tool) ?? { tool: a.tool, n: 0, errs: 0 };
    row.n += 1;
    if (/^(error|failed)\b/i.test(a.result || "")) row.errs += 1;
    map.set(a.tool, row);
  }
  return [...map.values()].sort((a, b) => b.n - a.n || a.tool.localeCompare(b.tool));
}

function Dot() {
  return <span className="select-none text-gray-500" aria-hidden>·</span>;
}

/**
 * The quiet footer under one answer: what the turn cost.
 *
 * Three facts, in the order a user asks for them — how long did it take, how
 * much did it look at, what did it cost. Expanding shows WHICH tools ran and how
 * often, which is the difference between "7 calls" and an understanding of the
 * investigation's shape.
 *
 * Tokens are shown only when the provider reported them. An estimate would be a
 * lie about money, so an endpoint that stays silent gets an explicit em dash
 * with an explanation on hover — never a zero.
 */
export function TurnMetricsBar({
  durationMs,
  usage,
  tools,
  model,
  onOpenInspector,
}: {
  durationMs?: number | null;
  usage?: TokenUsage | null;
  tools?: ToolActivity[];
  model?: string | null;
  onOpenInspector?: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const breakdown = useMemo(() => countByTool(tools ?? []), [tools]);
  const calls = breakdown.reduce((s, r) => s + r.n, 0);
  const dur = fmtDuration(durationMs);
  const inTok = fmtTokens(usage?.input_tokens);
  const outTok = fmtTokens(usage?.output_tokens);
  const hasTokens = inTok !== null || outTok !== null;
  // Model calls the turn made. Counted by the SDK, not reported by the endpoint,
  // so it is present exactly when token usage may not be.
  const r = usage?.requests;
  const reqs = typeof r === "number" && Number.isFinite(r) && r > 0 ? r : null;
  // PARTIAL reporting: some of the turn's model calls reported usage and some
  // did not, so the totals are a floor. Rendering them bare would state a figure
  // the endpoint never gave us — the same "confident number for an incomplete
  // measurement" the em-dash branch below already refuses to do for the
  // all-silent case. A "≥" and a tooltip naming the ratio is the whole fix.
  const rep = usage?.reported_requests;
  const partial =
    hasTokens && typeof rep === "number" && Number.isFinite(rep) && reqs !== null && rep < reqs
      ? { reported: rep, total: reqs }
      : null;

  // Nothing measured at all (an old message from before v0.45.0, or a turn that
  // never reached the server). Render nothing rather than a row of dashes.
  if (dur === null && !calls && !hasTokens && reqs === null) return null;

  const max = breakdown.length ? breakdown[0].n : 1;

  return (
    <div className="animate-fade-in select-none text-2xs text-gray-500">
      <div className="flex flex-wrap items-center gap-1.5">
        {dur && (
          <span className="tabular-nums" title={t("metrics.durationHint")}>
            {dur}
          </span>
        )}
        {dur && calls > 0 && <Dot />}
        {calls > 0 && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="inline-flex items-center gap-1 rounded transition-colors hover:text-gray-300"
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              className={`transition-transform ${open ? "rotate-90" : ""}`}
              aria-hidden
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
            <span className="tabular-nums">{t("metrics.tools", { n: calls })}</span>
            <span className="text-gray-500">({breakdown.length})</span>
          </button>
        )}
        {(dur || calls > 0) && <Dot />}
        {hasTokens ? (
          <span
            className="tabular-nums"
            title={
              partial
                ? t("metrics.partialHint", { reported: partial.reported, total: partial.total })
                : model
                  ? t("metrics.modelHint", { model })
                  : undefined
            }
          >
            <span className="text-gray-500">↑</span>
            {partial && <span className="text-gray-500">≥</span>}
            {inTok ?? "?"}
            <span className="ml-1.5 text-gray-500">↓</span>
            {partial && <span className="text-gray-500">≥</span>}
            {outTok ?? "?"}
          </span>
        ) : (
          // Honest absence. The tooltip explains WHY, so it doesn't read as a bug.
          //
          // The model-call count is shown BESIDE it when we have one (v0.77.0).
          // It is not a provider figure — the SDK counts the calls it makes — so
          // it survives an endpoint that reports no usage at all, which is the
          // only situation this branch renders in. Before, such a turn showed
          // nothing but an em dash; a multi-step investigation and a one-shot
          // answer looked identical.
          <span className="text-gray-500" title={t("metrics.tokensUnavailableHint")}>
            {t("metrics.tokens")} —
          </span>
        )}
        {!hasTokens && reqs !== null && (
          <>
            <Dot />
            <span className="tabular-nums" title={t("metrics.requestsHint")}>
              {t("metrics.requests", { n: reqs })}
            </span>
          </>
        )}
        {onOpenInspector && (
          <>
            <Dot />
            <button
              type="button"
              onClick={onOpenInspector}
              className="rounded transition-colors hover:text-accent-soft"
            >
              {t("metrics.inspect")}
            </button>
          </>
        )}
      </div>

      {open && breakdown.length > 0 && (
        <ul className="mt-1.5 space-y-1 border-l border-edge pl-3">
          {breakdown.map((r) => (
            <li key={r.tool} className="flex items-center gap-2">
              <span className="w-1/2 min-w-0 truncate font-mono text-2xs text-gray-500" title={r.tool}>
                {r.tool}
              </span>
              <span className="h-[3px] flex-1 overflow-hidden rounded-full bg-edge">
                <span
                  className={`block h-full rounded-full ${r.errs ? "bg-danger/60" : "bg-accent/45"}`}
                  style={{ width: `${Math.max(6, (r.n / max) * 100)}%` }}
                />
              </span>
              <span className="w-6 shrink-0 text-right tabular-nums text-gray-500">{r.n}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
