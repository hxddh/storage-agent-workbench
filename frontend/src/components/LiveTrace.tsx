import { useState } from "react";
import { CallDetail } from "./CallDetail";
import { useI18n } from "../i18n";
import type { ToolActivity } from "../types";
import { Icon } from "./icons";

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

function totalMs(items: ToolActivity[]): number | null {
  let sum = 0;
  let any = false;
  for (const item of items) {
    if (typeof item.duration_ms === "number" && Number.isFinite(item.duration_ms)) { sum += item.duration_ms; any = true; }
  }
  return any ? sum : null;
}

function fmtWorked(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

// Deep execution can run dozens of tools. Keep the latest work visible and fold
// older successful steps; failures are never folded away.
const FOLD_AFTER = 8;
const TAIL_WHEN_FOLDED = 6;

/** The Agent is working but has not emitted the first tool call yet. */
export function WorkingRow({ label }: { label: string }) {
  return (
    <div className="flex min-h-6 items-center gap-2 text-xs" data-testid="working-row">
      <span className="working-mark" data-testid="trace-running" aria-hidden />
      <span className="working-shimmer min-w-0 truncate" data-contrast-exempt>{label}</span>
    </div>
  );
}

function useTraceCopy() {
  const { lang } = useI18n();
  return lang === "zh"
    ? {
        working: "正在执行",
        worked: (n: number, dur: string | null) => `${dur ? `执行 ${dur}` : "已执行"} · ${n} 次工具调用`,
        hide: "收起",
        show: "展开",
      }
    : {
        working: "Working",
        worked: (n: number, dur: string | null) => `${dur ? `Worked for ${dur}` : "Worked"} · ${n} tool call${n === 1 ? "" : "s"}`,
        hide: "Hide",
        show: "Show",
      };
}

/**
 * Real tool work, grouped under one "Worked for …" line. Rows stay visible —
 * the disclosure only folds a long, finished trace; failures never fold away.
 */
export function LiveTrace({ items, sessionId, streaming = false }: { items: ToolActivity[]; sessionId?: string | null; streaming?: boolean }) {
  const { t } = useI18n();
  const copy = useTraceCopy();
  const [showAll, setShowAll] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [openCall, setOpenCall] = useState<string | null>(null);
  if (!items.length) return null;

  const running = streaming || items.some((item) => item.status === "started");
  const done = items.filter((item) => item.status !== "started").length;
  const worked = totalMs(items);
  const folded = !showAll && items.length > FOLD_AFTER;
  const hiddenCount = folded ? items.length - TAIL_WHEN_FOLDED : 0;
  const shown = folded
    ? items.filter((a, i) => i >= items.length - TAIL_WHEN_FOLDED || isFailed(a))
    : items;

  return (
    <div className="native-execution" data-testid="live-trace" data-running={running ? "true" : "false"}>
      <button
        type="button"
        className="native-execution-head"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((value) => !value)}
        data-testid="execution-head"
      >
        <Icon name="chevron" size={12} className="chevron" />
        {running ? (
          <span className="flex items-center gap-2">
            <span className="working-mark" style={{ width: 6, height: 6 }} aria-hidden />
            <span className="working-shimmer" data-contrast-exempt>{copy.working}</span>
            {done > 0 ? <span className="text-gray-500">· {done}</span> : null}
          </span>
        ) : (
          <span>{copy.worked(items.length, worked !== null ? fmtWorked(worked) : null)}</span>
        )}
      </button>

      {!collapsed ? (
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
              <div key={a.id ?? i}>
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
  );
}
