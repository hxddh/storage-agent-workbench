import { useState } from "react";
import { CallDetail } from "./CallDetail";
import { useI18n } from "../i18n";
import type { ToolActivity, ToolProgress } from "../types";
import { Icon } from "./icons";
import { fmtElapsed, useElapsed } from "../hooks/useElapsed";
import { toolLabel } from "../lib/toolLabels";

export function argLabel(key: string, value: string | number | boolean): string {
  if (value === true) return `·${key}`;
  if (typeof value === "number") return `·${value}`;
  const s = String(value);
  return s.length > 28 ? `${s.slice(0, 28)}…` : s;
}

/** The call's arguments, minus any value the row already shows as its
 * target (`head_bucket bucket-1 bucket-1` said the bucket twice). */
export function argSummary(args?: Record<string, string | number | boolean> | null, target?: string | null): string {
  if (!args) return "";
  return Object.entries(args)
    .filter(([, v]) => !(target && typeof v === "string" && v === target))
    .map(([k, v]) => argLabel(k, v))
    .join(" ");
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

/** "120 of 500 buckets" — counts the engine finished, never a guess (v2.2). */
export function progressLabel(p: ToolProgress, t: (key: string, vars?: Record<string, string | number>) => string): string {
  const key = `tool.unit.${p.unit}`;
  const unit = t(key);
  return t("tool.progress", { done: p.done, total: p.total, unit: unit === key ? p.unit : unit });
}

/** The Agent is working but has not emitted the first item yet. */
export function WorkingRow({ label }: { label: string }) {
  return (
    <div className="working-row" data-testid="working-row">
      <span className="working-mark" data-testid="trace-running" aria-hidden />
      <span className="working-shimmer min-w-0 truncate" data-contrast-exempt>{label}</span>
    </div>
  );
}

/**
 * One "Worked for …" group of real tool rows between two segments of a turn.
 * Expanded while live, collapsed once done (click to open); a failed row keeps
 * the group open. Rows: glyph · tool · target · result · duration.
 */
export function WorkedGroup({
  records,
  taskId,
  live = false,
  startedAt = null,
  /** Find holds a runnable query: render every row — folded rows are
   * unmounted, and unmounted rows are unfindable. */
  forceExpanded = false,
  /** v2.1 — the turn is live: keep every group open until the turn settles,
   * so the reader sees what ran even after the Agent started writing. */
  keepOpen = false,
}: {
  records: ToolActivity[];
  taskId?: string | null;
  /** The turn is still executing (the group may still grow). */
  live?: boolean;
  /** When the turn started — the live clock's fallback before any row carries its own start. */
  startedAt?: number | null;
  forceExpanded?: boolean;
  keepOpen?: boolean;
}) {
  const { t, lang } = useI18n();
  const running = live || records.some((item) => item.status === "started");
  const anyFailed = records.some(isFailed);
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<boolean | null>(null);
  const [openCall, setOpenCall] = useState<string | null>(null);
  const elapsed = useElapsed(groupStartMs(records) ?? startedAt, running);
  if (!records.length) return null;

  const expanded = open ?? (forceExpanded || running || keepOpen || anyFailed);
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
    ? t("turn.workedFor", { t: fmtElapsed(worked) ?? "" })
    : t("turn.worked");

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
          <Icon name="chevron" size={14} className="chevron" />
          {running ? (
            <span className="flex items-center gap-2">
              <span className="working-mark" style={{ width: 6, height: 6 }} aria-hidden />
              <span className="working-shimmer" data-contrast-exempt data-testid="worked-elapsed">{liveLabel}</span>
              {done > 0 ? <span className="worked-count">· {done}</span> : null}
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
                className="native-tool-row native-tool-fold"
              >
                {t("trace.showEarlier", { n: hiddenCount })}
              </button>
            )}
            {shown.map((a, i) => {
              const isRunning = a.status === "started";
              const args = argSummary(a.args, a.target);
              const failed = isFailed(a);
              const ms = fmtCallMs(a.duration_ms);
              const canOpen = Boolean(taskId && a.id && !isRunning);
              const isOpen = canOpen && openCall === a.id;
              return (
                <div key={a.id ?? i} data-testid="worked-row" data-tool={a.tool} data-status={isRunning ? "running" : failed ? "failed" : "ok"}>
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
                        <span data-testid="trace-failed" aria-hidden><Icon name="x" size={14} stroke={1.75} /></span>
                      ) : (
                        <Icon name="check" size={14} stroke={1.75} />
                      )}
                    </span>
                    <span className="native-tool-name" title={a.tool}>{toolLabel(a.tool, lang)}</span>
                    {a.target ? <span className="native-tool-target" title={a.target}>{a.target}</span> : null}
                    {args ? <span className="native-tool-target font-mono" data-testid="trace-args" title={args}>{args}</span> : null}
                    {a.audit_error && !isRunning ? (
                      <span
                        className="native-tool-audit"
                        data-testid="trace-audit-gap"
                        title={t("trace.auditGap", { reason: a.audit_error })}
                        aria-label={t("trace.auditGap", { reason: a.audit_error })}
                      >
                        <Icon name="alert" size={14} />
                      </span>
                    ) : null}
                    {isRunning && a.progress ? (
                      <span className="native-tool-result native-tool-progress" data-testid="tool-progress">
                        {progressLabel(a.progress, t)}
                      </span>
                    ) : isRunning ? (
                      <span className="native-tool-result">{t("tool.running")}</span>
                    ) : (
                      <span className="native-tool-result" title={a.result}>{a.result}</span>
                    )}
                    {ms && !isRunning ? <span className="native-tool-ms" data-testid="trace-duration">{ms}</span> : null}
                  </div>
                  {isRunning && a.progress ? (
                    <div
                      className="native-tool-meter"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={a.progress.total}
                      aria-valuenow={a.progress.done}
                      aria-label={progressLabel(a.progress, t)}
                    >
                      <span style={{ width: `${Math.round((100 * a.progress.done) / Math.max(1, a.progress.total))}%` }} />
                    </div>
                  ) : null}
                  {isOpen && <CallDetail taskId={taskId as string} callId={a.id as string} />}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </section>
  );
}
