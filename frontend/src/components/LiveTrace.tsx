import { useState } from "react";
import { CallDetail } from "./CallDetail";
import { useI18n } from "../i18n";
import type { ToolActivity } from "../types";

/** Live Agent execution: the rows themselves are the progress indicator. */
export function argLabel(key: string, value: string | number | boolean): string {
  if (value === true) return `·${key}`;
  if (typeof value === "number") return `·${value}`;
  const s = String(value);
  return s.length > 28 ? `${s.slice(0, 28)}…` : s;
}

export function argSummary(args?: Record<string, string | number | boolean> | null): string {
  if (!args) return "";
  return Object.entries(args).map(([k, v]) => argLabel(k, v)).join(" ");
}

/** Prefer the Sidecar verdict; retain a conservative fallback for old persisted data. */
export function isFailed(a: ToolActivity): boolean {
  if (typeof a.ok === "boolean") return !a.ok;
  return /^(error|failed)\b/i.test(a.result || "");
}

/** A call's measured wall-clock at actionable precision. */
export function fmtCallMs(ms?: number | null): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 100) return null;
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// Deep execution can run dozens of tools. Keep the latest work visible and fold
// older successful steps; failures are never folded away.
const FOLD_AFTER = 8;
const TAIL_WHEN_FOLDED = 6;

const Wrench = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
       className="shrink-0 text-gray-500" aria-hidden>
    <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.7 2.7-2-2 2.7-2.7z" />
  </svg>
);

/** The Agent is working but has not emitted the first tool call yet. */
export function WorkingRow({ label }: { label: string }) {
  return (
    <div className="flex min-h-5 items-center gap-2 text-2xs text-gray-500" data-testid="working-row">
      <span className="working-mark" data-testid="trace-running" aria-hidden />
      <span className="min-w-0 truncate">{label}</span>
    </div>
  );
}

export function LiveTrace({ items, sessionId }: { items: ToolActivity[]; sessionId?: string | null }) {
  const { t } = useI18n();
  const [showAll, setShowAll] = useState(false);
  const [openCall, setOpenCall] = useState<string | null>(null);
  if (!items.length) return null;

  const folded = !showAll && items.length > FOLD_AFTER;
  const hiddenCount = folded ? items.length - TAIL_WHEN_FOLDED : 0;
  const shown = folded
    ? items.filter((a, i) => i >= items.length - TAIL_WHEN_FOLDED || isFailed(a))
    : items;

  return (
    <div className="mb-2.5 space-y-0.5" data-testid="live-trace">
      {folded && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          data-testid="trace-fold"
          className="flex items-center gap-2 text-2xs text-gray-500 transition-colors hover:text-gray-400"
        >
          <span className="w-3" aria-hidden />
          {t("trace.showEarlier", { n: hiddenCount })}
        </button>
      )}
      {shown.map((a, i) => {
        const running = a.status === "started";
        const args = argSummary(a.args);
        const failed = isFailed(a);
        const ms = fmtCallMs(a.duration_ms);
        const canOpen = Boolean(sessionId && a.id && !running);
        const isOpen = canOpen && openCall === a.id;
        return (
          <div key={a.id ?? i}>
            <div
              className={`flex min-h-5 items-center gap-2 text-2xs text-gray-500 ${canOpen ? "cursor-pointer rounded-md px-0.5 transition-colors hover:bg-hover" : ""}`}
              {...(canOpen
                ? {
                    role: "button" as const,
                    tabIndex: 0,
                    "aria-expanded": isOpen,
                    "data-testid": "trace-row-open",
                    onClick: () => setOpenCall(isOpen ? null : (a.id as string)),
                    onKeyDown: (e: React.KeyboardEvent) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setOpenCall(isOpen ? null : (a.id as string));
                      }
                    },
                  }
                : {})}
            >
              {running ? (
                <span className="working-mark" data-testid="trace-running" aria-hidden />
              ) : failed ? (
                <span className="shrink-0 text-danger" data-testid="trace-failed" aria-hidden>✕</span>
              ) : Wrench}
              <span className={`shrink-0 font-mono ${failed ? "text-danger" : "text-accent-soft"}`}>{a.tool}</span>
              <span className="flex min-w-0 flex-1 items-baseline gap-1.5 truncate">
                {a.target && <span className="truncate text-gray-500" title={a.target}>· {a.target}</span>}
                {args && <span className="shrink-0 truncate font-mono text-2xs text-gray-500" data-testid="trace-args" title={args}>{args}</span>}
              </span>
              {a.audit_error && !running && (
                <span
                  className="shrink-0 text-warn-fg"
                  data-testid="trace-audit-gap"
                  title={t("trace.auditGap", { reason: a.audit_error })}
                  aria-label={t("trace.auditGap", { reason: a.audit_error })}
                >
                  ⚠
                </span>
              )}
              {ms && !running && <span className="shrink-0 tabular-nums text-2xs text-gray-500" data-testid="trace-duration">{ms}</span>}
              {running ? (
                <span className="shrink-0 text-2xs text-warn-fg">{t("tool.running")}</span>
              ) : (
                <span className={`shrink-0 truncate font-mono text-2xs ${failed ? "text-danger" : "text-gray-500"}`} title={a.result}>{a.result}</span>
              )}
            </div>
            {isOpen && <CallDetail sessionId={sessionId as string} callId={a.id as string} />}
          </div>
        );
      })}
    </div>
  );
}
