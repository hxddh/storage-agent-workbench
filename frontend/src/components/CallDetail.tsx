import { useEffect, useState } from "react";
import { getTaskCall } from "../api";
import { useCopy } from "../hooks/useCopy";
import { useI18n } from "../i18n";
import type { TaskCallRecord } from "../types";
import { StatusDot } from "./ui";

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
// execution review into a new performance problem, so the in-place preview is
// deliberately bounded. The UI always states the cut instead of pretending the
// payload ended there.
const MAX_RENDER = 4000;

function PayloadBlock({ label, value }: { label: string; value: unknown }) {
  const { t } = useI18n();
  const { copied, copy } = useCopy();
  const text = present(value);
  const clipped = text.length > MAX_RENDER;
  const visible = clipped ? `${text.slice(0, MAX_RENDER)}\n…` : text;

  return (
    <section className="call-payload" data-testid="call-payload">
      <div className="call-payload-head">
        <div className="call-payload-label">
          {label}
        </div>
        <button
          type="button"
          onClick={() => copy(text)}
          className="call-payload-copy"
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
      <pre className="call-payload-body">
        {visible}
      </pre>
      {clipped && (
        <div className="call-payload-clipped">
          {t("call.clipped", { n: text.length - MAX_RENDER })}
        </div>
      )}
    </section>
  );
}

/**
 * What a tool call actually sent and got back, opened in place under the step.
 *
 * This is a focused execution-evidence viewer. It fetches exactly one sanitized
 * persisted call on demand, keeps input and output visually parallel, and makes
 * either side directly copyable. On a narrow window the two payloads stack; on
 * a wide task work area they sit side-by-side for direct comparison.
 */
export function CallDetail({ taskId, callId }: { taskId: string; callId: string }) {
  const { t } = useI18n();
  const [row, setRow] = useState<TaskCallRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setRow(null);
    setError(null);
    getTaskCall(taskId, callId)
      .then((result) => alive && setRow(result))
      .catch((reason) => alive && setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      alive = false;
    };
  }, [taskId, callId]);

  if (error) {
    return (
      <div
        className="call-detail-note"
        data-testid="call-detail-error"
        title={error}
      >
        <StatusDot tone="danger" />
        {t("call.unavailable")}
      </div>
    );
  }

  if (!row) {
    return (
      <div
        className="call-detail-note"
        data-testid="call-detail-loading"
      >
        <StatusDot tone="accent" pulse />
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
