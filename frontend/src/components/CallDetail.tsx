import { useEffect, useState } from "react";
import { getSessionCall } from "../api";
import { useI18n } from "../i18n";
import type { SessionActivityItem } from "../types";

/**
 * What a tool call actually sent and got back — opened in place, under its row.
 *
 * The sidecar has written every call's sanitized input and output to
 * `tool_calls` since v0.45.0, and v0.55.0 gave the thread row the SAME id as
 * that row. Until now none of it was reachable from the thread: a reader who
 * wanted to know what `list_objects · acme-logs` was actually called with had to
 * open the whole-session inspector and scroll to a guessed time window.
 *
 * Codex and Cursor both let you open a step and read it. This is that, and it is
 * cheap: one row, fetched on demand, only when a reader asks.
 *
 * Nothing new is exposed. The row was redacted on write (rule 15) and is the
 * same one `/activity` already returns in bulk to the inspector.
 */

/** Pretty-print a sanitized payload for reading, not for round-tripping. */
function present(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// A single call's output can be a full listing page. Clamp what is rendered so
// opening a row can never blow up the thread; the full text stays available by
// selection/scroll inside the block.
const MAX_RENDER = 4000;

export function CallDetail({ sessionId, callId }: { sessionId: string; callId: string }) {
  const { t } = useI18n();
  const [row, setRow] = useState<SessionActivityItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setRow(null);
    setError(null);
    getSessionCall(sessionId, callId)
      .then((r) => alive && setRow(r))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      // A reader who collapses the row (or switches session) before the fetch
      // lands must not get a state update on an unmounted component.
      alive = false;
    };
  }, [sessionId, callId]);

  if (error) {
    return (
      <div className="ml-6 mt-1 rounded border border-edge bg-panel px-2.5 py-2 text-2xs text-gray-500"
           data-testid="call-detail-error">
        {t("call.unavailable")}
      </div>
    );
  }
  if (!row) {
    return (
      <div className="ml-6 mt-1 animate-pulse text-2xs text-gray-500" data-testid="call-detail-loading">
        {t("call.loading")}
      </div>
    );
  }

  const blocks: Array<[string, unknown]> = [
    [t("call.input"), row.input],
    [t("call.output"), row.output],
  ];

  return (
    <div className="ml-6 mt-1 space-y-2 rounded border border-edge bg-panel px-2.5 py-2"
         data-testid="call-detail">
      {blocks.map(([label, value]) => {
        const text = present(value);
        const clipped = text.length > MAX_RENDER;
        return (
          <div key={label}>
            <div className="mb-1 text-2xs font-medium uppercase tracking-wider text-gray-500">
              {label}
            </div>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-elevated px-2 py-1.5 font-mono text-2xs leading-relaxed text-gray-400">
              {clipped ? `${text.slice(0, MAX_RENDER)}\n…` : text}
            </pre>
            {clipped && (
              // Never a silent cut — the same rule the sidecar follows.
              <div className="mt-0.5 text-2xs text-gray-500">
                {t("call.clipped", { n: text.length - MAX_RENDER })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
