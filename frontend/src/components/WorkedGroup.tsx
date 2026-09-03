import { useState } from "react";
import { CallDetail } from "./CallDetail";
import { useI18n } from "../i18n";
import type { ToolActivity } from "../types";
import { Icon } from "./icons";
import { fmtElapsed, useElapsed } from "../hooks/useElapsed";

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

const stamp = (value?: string | null): number | null => {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

/** When the group's first row started (v1.12): the live "Worked for" clock
 * runs from here, not from the turn's start. Null until a row carries it. */
export function groupStartMs(items: ToolActivity[]): number | null {
  let min: number | null = null;
  for (const item of items) {
    const at = stamp(item.started_at);
    if (at != null && (min == null || at < min)) min = at;
  }
  return min;
}

/**
 * The group's wall-clock (v1.12): first start → last finish when every row
 * carries both stamps; otherwise the longest single call — tools run in
 * parallel, so a sum of durations would overstate the wait.
 */
export function groupSpanMs(items: ToolActivity[]): number | null {
  if (!items.length) return null;
  const starts = items.map((item) => stamp(item.started_at));
  const ends = items.map((item) => stamp(item.finished_at));
  if (starts.every((at) => at != null) && ends.every((at) => at != null)) {
    return Math.max(0, Math.max(...(ends as number[])) - Math.min(...(starts as number[])));
  }
  let max: number | null = null;
  for (const item of items) {
    if (typeof item.duration_ms === "number" && Number.isFinite(item.duration_ms) && (max == null || item.duration_ms > max)) max = item.duration_ms;
  }
  return max;
}

// Deep execution can run dozens of tools. Keep the latest work visible and fold
// older successful steps; failures are never folded away.
const FOLD_AFTER = 8;
const TAIL_WHEN_FOLDED = 6;

/**
 * One "Worked for …" group of real tool rows between two segments of a turn.
 * Expanded while live, collapsed once done (click to open); a failed row keeps
 * the group open. Rows: glyph · tool · target · result · duration.
 */
export function WorkedGroup({
  records,
  sessionId,
  live = false,
  startedAt = null,
  /** Find holds a runnable query: render every row — folded rows are
   * unmounted, and unmounted rows are unfindable. */
  forceExpanded = false,
}: {
  records: ToolActivity[];
  sessionId?: string | null;
  /** The turn is still executing (the group may still grow). */
  live?: boolean;
  /** When the turn started — the live clock's fallback before any row carries its own start. */
  startedAt?: number | null;
  forceExpanded?: boolean;
}) {
  const { t } = useI18n();
  const running = live || records.some((item) => item.status === "started");
  const anyFailed = records.some(isFailed);
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<boolean | null>(null);
  const [openCall, setOpenCall] = useState<string | null>(null);
  const elapsed = useElapsed(groupStartMs(records) ?? startedAt, running);
  if (!records.length) return null;

  const expanded = open ?? (forceExpanded || running || anyFailed);
  const done = records.filter((item) => item.status !== "started").length;
  const worked = groupSpanMs(records);
  const folded = !forceExpanded && !showAll && records.length > FOLD_AFTER;
  const hiddenCount = folded ? records.length - TAIL_WHEN_FOLDED : 0;
  const shown = folded
    ? records.filter((a, i) => i >= records.length - TAIL_WHEN_FOLDED || isFailed(a))
    : records;
  const liveLabel = elapsed != null && elapsed >= 1000
    ? t("turn.workingFor", { t: fmtElapsed(elapsed) ?? "" })
    : t("turn.working");
  const doneLabel = worked !== null
    ? t("turn.workedFor", { t: fmtElapsed(worked) ?? "", n: records.length })
    : t("turn.worked", { n: records.length });

  return (
    <section className="native-execution" data-testid="worked-group" data-expanded={expanded ? "true" : "false"}>
      <div data-testid="live-trace" data-running={running ? "true" : "false"}>
        <button
          type="button"
          className="native-execution-head"
          aria-expanded={expanded}
          onClick={() => setOpen(!expanded)}
          data-testid="execution-head"
        >
          <Icon name="chevron" size={12} className="chevron" />
          {running ? (
            <span className="flex items-center gap-2">
              <span className="working-mark" style={{ width: 6, height: 6 }} aria-hidden />
              <span className="working-shimmer" data-contrast-exempt data-testid="worked-elapsed">{liveLabel}</span>
              {done > 0 ? <span className="text-gray-500">· {done}</span> : null}
            </span>
          ) : (
            <span>{doneLabel}</span>
          )}
        </button>

        {expanded ? (
          <div className="native-execution-rows">
            {folded && (
              <button
                type="button"
                onClick={() => setShowAll(true)}
                data-testid="trace-fold"
                className="native-tool-row text-gray-500 hover:text-gray-300"
              >
                {t("trace.showEarlier", { n: hiddenCount })}
              </button>
            )}
            {shown.map((a, i) => {
              const isRunning = a.status === "started";
              const args = argSummary(a.args);
              const failed = isFailed(a);
              const ms = fmtCallMs(a.duration_ms);
              const canOpen = Boolean(sessionId && a.id && !isRunning);
              const isOpen = canOpen && openCall === a.id;
              return (
                <div key={a.id ?? i} data-testid="worked-row" data-status={isRunning ? "running" : failed ? "failed" : "ok"}>
                  <div
                    className="native-tool-row"
                    data-failed={failed ? "true" : "false"}
                    data-open={canOpen ? "true" : "false"}
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
                    <span className="native-tool-glyph" data-status={isRunning ? "running" : failed ? "failed" : "ok"}>
                      {isRunning ? (
                        <span className="working-mark" style={{ width: 6, height: 6 }} data-testid="trace-running" aria-hidden />
                      ) : failed ? (
                        <span data-testid="trace-failed" aria-hidden><Icon name="x" size={11} stroke={2.2} /></span>
                      ) : (
                        <Icon name="check" size={11} stroke={2.2} />
                      )}
                    </span>
                    <span className="native-tool-name">{a.tool}</span>
                    {a.target ? <span className="native-tool-target" title={a.target}>{a.target}</span> : null}
                    {args ? <span className="native-tool-target font-mono" data-testid="trace-args" title={args}>{args}</span> : null}
                    {a.audit_error && !isRunning ? (
                      <span
                        className="shrink-0 text-warn-fg"
                        data-testid="trace-audit-gap"
                        title={t("trace.auditGap", { reason: a.audit_error })}
                        aria-label={t("trace.auditGap", { reason: a.audit_error })}
                      >
                        <Icon name="alert" size={12} />
                      </span>
                    ) : null}
                    {isRunning ? (
                      <span className="native-tool-result">{t("tool.running")}</span>
                    ) : (
                      <span className="native-tool-result" title={a.result}>{a.result}</span>
                    )}
                    {ms && !isRunning ? <span className="native-tool-ms" data-testid="trace-duration">{ms}</span> : null}
                  </div>
                  {isOpen && <CallDetail sessionId={sessionId as string} callId={a.id as string} />}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </section>
  );
}
