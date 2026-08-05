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

const Wrench = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
       className="shrink-0 text-gray-600" aria-hidden>
    <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.7 2.7-2-2 2.7-2.7z" />
  </svg>
);

export function LiveTrace({ items }: { items: ToolActivity[] }) {
  const { t } = useI18n();
  if (!items.length) return null;
  return (
    <div className="mb-2.5 space-y-[3px]" data-testid="live-trace">
      {items.map((a, i) => {
        const running = a.status === "started";
        const args = argSummary(a.args);
        return (
          <div key={i} className="flex items-center gap-2 text-[11.5px] text-gray-500">
            {running ? (
              <span
                className="h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent text-warn-fg"
                aria-hidden
              />
            ) : (
              Wrench
            )}
            <span className="shrink-0 font-mono text-accent-soft">{a.tool}</span>
            <span className="flex min-w-0 flex-1 items-baseline gap-1.5 truncate">
              {a.target && (
                <span className="truncate text-gray-600" title={a.target}>· {a.target}</span>
              )}
              {args && (
                <span className="shrink-0 truncate font-mono text-[10.5px] text-gray-700"
                      data-testid="trace-args" title={args}>
                  {args}
                </span>
              )}
            </span>
            {running ? (
              <span className="shrink-0 text-[11px] text-warn-fg">{t("tool.running")}</span>
            ) : (
              <span className="shrink-0 truncate font-mono text-[11px] text-gray-500" title={a.result}>
                {a.result}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
