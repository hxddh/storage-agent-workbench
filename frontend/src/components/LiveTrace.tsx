import { useState } from "react";
import { CallDetail } from "./CallDetail";
import { useI18n } from "../i18n";
import type { ToolActivity } from "../types";

/**
 * What the agent is doing, right now — one surface.
 *
 * The live state carried the same duplication v0.49.0 removed from the finished
 * state: a `LiveProgress` summary line ("5 checks run · list_objects ·
 * acme-logs") rendered directly above a `ToolActivityList` that showed every one
 * of those calls as its own row. Two components, one event stream, stacked.
 *
 * This is the merged one: the rows ARE the progress indicator, and the newest
 * row carries the spinner. Codex and Cursor both settle here — a growing list
 * where the last line is live — because a separate counter tells you nothing the
 * list does not already show.
 *
 * The second change is what a row SAYS. It used to render the bucket:
 *
 *     list_objects · acme-logs
 *
 * when the call was `list_objects(prefix="logs/2026/08/", max_keys=1000,
 * recursive=true)`. Three arguments that decide what the call means were
 * invisible while it ran — and they had been written to `tool_calls` all along,
 * just never sent to the client. Now:
 *
 *     list_objects · acme-logs  logs/2026/08/ ·1000 ·recursive
 */

/** Render one argument the way an operator reads it: a bare value for a path,
 * `·n` for a count, a bare flag name for a boolean. Keys like `max_keys` are
 * noise once the value's shape says what it is. */
export function argLabel(key: string, value: string | number | boolean): string {
  if (value === true) return `·${key}`;
  if (typeof value === "number") return `·${value}`;
  const s = String(value);
  // Long ids (upload_id, version_id, etag) are unreadable in full and useless
  // truncated in the middle — keep the head, which is what distinguishes them.
  return s.length > 28 ? `${s.slice(0, 28)}…` : s;
}

export function argSummary(args?: Record<string, string | number | boolean> | null): string {
  if (!args) return "";
  return Object.entries(args)
    .map(([k, v]) => argLabel(k, v))
    .join(" ");
}

/** Did this call fail?
 *
 * The sidecar computes it exactly and sends `ok` (v0.55.0). Before that the UI
 * pattern-matched the result text with /^(error|failed)\b/ — which matched NONE
 * of the failure shapes this product actually produces, so `AccessDenied · req
 * 8A9F2C1B`, `NoSuchBucket` and `SignatureDoesNotMatch` all rendered as
 * successes and the "N failed" badge under-counted. The regex survives only for
 * history persisted before `ok` existed.
 */
export function isFailed(a: ToolActivity): boolean {
  if (typeof a.ok === "boolean") return !a.ok;
  return /^(error|failed)\b/i.test(a.result || "");
}

/** A call's measured wall-clock, at the precision a reader can act on. */
export function fmtCallMs(ms?: number | null): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  // Sub-100ms is noise between steps; showing it would imply a precision the
  // number does not have once network jitter is in it.
  if (ms < 100) return null;
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// A deep turn can run dozens of tools. Codex and Cursor both keep the tail
// visible and fold the rest, because the newest rows are the ones that explain
// what is happening now — an unbounded list pushes the answer off screen
// entirely (this app allows up to _MAX_TURNS = 60 calls in one turn).
const FOLD_AFTER = 8;
const TAIL_WHEN_FOLDED = 6;

const Wrench = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
       className="shrink-0 text-gray-600" aria-hidden>
    <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.7 2.7-2-2 2.7-2.7z" />
  </svg>
);

export function LiveTrace({ items, sessionId }: { items: ToolActivity[]; sessionId?: string | null }) {
  const { t } = useI18n();
  const [showAll, setShowAll] = useState(false);
  // Which row the reader has opened. One at a time: this sits inside a live
  // trace, and stacking open payloads would push the answer off screen — the
  // exact problem the fold above exists to prevent.
  const [openCall, setOpenCall] = useState<string | null>(null);
  if (!items.length) return null;

  // Fold the head, never the tail: the newest rows are what explains what the
  // agent is doing right now. A failed call is never folded away — it is the
  // one row a reader most needs to see.
  const folded = !showAll && items.length > FOLD_AFTER;
  const hiddenCount = folded ? items.length - TAIL_WHEN_FOLDED : 0;
  const shown = folded
    ? items.filter((a, i) => i >= items.length - TAIL_WHEN_FOLDED || isFailed(a))
    : items;

  return (
    <div className="mb-2.5 space-y-[3px]" data-testid="live-trace">
      {folded && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          data-testid="trace-fold"
          className="flex items-center gap-2 text-2xs text-gray-600 transition-colors hover:text-gray-400"
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
        // A row is openable once the call has finished and carries its id — the
        // id is the link to the persisted row holding its real input/output.
        const canOpen = Boolean(sessionId && a.id && !running);
        const isOpen = canOpen && openCall === a.id;
        return (
          <div key={a.id ?? i}>
          <div
            className={`flex items-center gap-2 text-2xs text-gray-500 ${
              canOpen ? "cursor-pointer rounded transition-colors hover:bg-hover" : ""
            }`}
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
              <span
                className="h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent text-warn-fg"
                aria-hidden
              />
            ) : failed ? (
              <span className="shrink-0 text-danger" data-testid="trace-failed" aria-hidden>✕</span>
            ) : (
              Wrench
            )}
            <span className={`shrink-0 font-mono ${failed ? "text-danger" : "text-accent-soft"}`}>
              {a.tool}
            </span>
            <span className="flex min-w-0 flex-1 items-baseline gap-1.5 truncate">
              {a.target && (
                <span className="truncate text-gray-600" title={a.target}>· {a.target}</span>
              )}
              {args && (
                <span className="shrink-0 truncate font-mono text-3xs text-gray-700"
                      data-testid="trace-args" title={args}>
                  {args}
                </span>
              )}
            </span>
            {ms && !running && (
              // Measured since v0.45.0, written to `tool_calls`, and never sent
              // to the client until now — so "which step was slow" had no answer
              // in the thread.
              <span className="shrink-0 tabular-nums text-3xs text-gray-700"
                    data-testid="trace-duration">
                {ms}
              </span>
            )}
            {running ? (
              <span className="shrink-0 text-2xs text-warn-fg">{t("tool.running")}</span>
            ) : (
              <span
                className={`shrink-0 truncate font-mono text-2xs ${failed ? "text-danger" : "text-gray-500"}`}
                title={a.result}
              >
                {a.result}
              </span>
            )}
          </div>
          {isOpen && <CallDetail sessionId={sessionId as string} callId={a.id as string} />}
          </div>
        );
      })}
    </div>
  );
}
