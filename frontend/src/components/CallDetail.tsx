import { useEffect, useState } from "react";
import { getSessionCall } from "../api";
import { useI18n } from "../i18n";
import type { SessionActivityItem } from "../types";

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

// A single call can return a full listing page. Rendering megabytes inline turns
// evidence inspection into a new performance problem, so the in-thread preview
// is deliberately bounded. The UI always states the cut instead of pretending
// the payload ended there.
const MAX_RENDER = 4000;

function copyText(text: string, done: () => void) {
  const fallback = () => {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      done();
    } catch {
      /* no remaining clipboard path */
    }
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done).catch(fallback);
  else fallback();
}

function PayloadBlock({ label, value }: { label: string; value: unknown }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const text = present(value);
  const clipped = text.length > MAX_RENDER;
  const visible = clipped ? `${text.slice(0, MAX_RENDER)}\n…` : text;

  return (
    <section className="group/payload min-w-0 rounded-lg bg-elevated/65 px-2.5 py-2" data-testid="call-payload">
      <div className="mb-1.5 flex h-5 items-center gap-2">
        <div className="text-2xs font-semibold uppercase tracking-[0.08em] text-gray-500">
          {label}
        </div>
        <button
          type="button"
          onClick={() => copyText(text, () => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1400);
          })}
          className="ml-auto inline-flex items-center gap-1 rounded px-1 py-0.5 text-2xs text-gray-500 opacity-0 transition-[color,opacity] hover:text-gray-200 group-hover/payload:opacity-100 focus:opacity-100"
        >
          {copied ? (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden>
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <rect x="9" y="9" width="13" height="13" rx="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
          {copied ? t("common.copied") : t("common.copy")}
        </button>
      </div>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-gray-400 [scrollbar-gutter:stable]">
        {visible}
      </pre>
      {clipped && (
        <div className="mt-1 text-2xs text-gray-500">
          {t("call.clipped", { n: text.length - MAX_RENDER })}
        </div>
      )}
    </section>
  );
}

/**
 * What a tool call actually sent and got back, opened in place under the step.
 *
 * This is an evidence viewer, not a second inspector. It fetches exactly one
 * sanitized persisted call on demand, keeps input and output visually parallel,
 * and makes either side directly copyable. On a narrow window the two payloads
 * stack; on a wide work surface they sit side-by-side so request and result can
 * be compared without scrolling back and forth.
 */
export function CallDetail({ sessionId, callId }: { sessionId: string; callId: string }) {
  const { t } = useI18n();
  const [row, setRow] = useState<SessionActivityItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setRow(null);
    setError(null);
    getSessionCall(sessionId, callId)
      .then((result) => alive && setRow(result))
      .catch((reason) => alive && setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      alive = false;
    };
  }, [sessionId, callId]);

  if (error) {
    return (
      <div
        className="mt-1 rounded-lg bg-danger-bg px-2.5 py-2 text-xs text-danger"
        data-testid="call-detail-error"
        title={error}
      >
        {t("call.unavailable")}
      </div>
    );
  }

  if (!row) {
    return (
      <div
        className="mt-1 flex min-h-9 items-center gap-2 rounded-lg bg-panel/45 px-2.5 text-xs text-gray-500"
        data-testid="call-detail-loading"
      >
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" aria-hidden />
        {t("call.loading")}
      </div>
    );
  }

  return (
    <div className="mt-1 grid min-w-0 gap-2 lg:grid-cols-2" data-testid="call-detail">
      <PayloadBlock label={t("call.input")} value={row.input} />
      <PayloadBlock label={t("call.output")} value={row.output} />
    </div>
  );
}
