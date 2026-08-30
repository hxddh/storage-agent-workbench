import type { NextAction } from "../types";
import type { DecisionImpact } from "../api";
import { useI18n } from "../i18n";

const ArrowIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <line x1="5" y1="12" x2="19" y2="12" />
    <polyline points="13 6 19 12 13 18" />
  </svg>
);

const DecisionIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 3 4.5 6v5.8c0 4.8 3.2 7.7 7.5 9.2 4.3-1.5 7.5-4.4 7.5-9.2V6L12 3Z" />
    <path d="M9.2 12.2 11 14l3.8-4" />
  </svg>
);

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

function impactFromAction(action: NextAction, impact?: DecisionImpact | null): DecisionImpact | null {
  if (impact) return impact;
  const prefill = action.prefill || {};
  const bucket = typeof prefill.bucket === "string" ? prefill.bucket
    : typeof prefill.bucket_name === "string" ? prefill.bucket_name : null;
  const prefix = typeof prefill.prefix === "string" ? prefill.prefix : null;
  const sourceType = typeof prefill.source_type === "string" ? prefill.source_type : null;
  if (!bucket && !prefix && !sourceType && !action.reason) return null;
  const gate = action.action_type.includes("import") ? "cloud_download"
    : action.action_type.includes("report") ? "artifact_write" : "confirmation";
  return {
    gate,
    why: action.reason,
    bucket,
    prefix,
    source_type: sourceType,
    file_count: null,
    total_bytes: null,
    scan_scope: prefix ? `prefix ${prefix}` : null,
  };
}

/** A real Agent next-action boundary backed by the backend confirmation contract. */
export function AgentNextAction({
  action,
  onRun,
  onDecline,
  impact,
}: {
  action: NextAction;
  onRun: (action: NextAction) => void;
  onDecline?: (action: NextAction) => void;
  impact?: DecisionImpact | null;
}) {
  const { lang } = useI18n();
  const zh = lang === "zh";
  const label = action.action_type === "continue_investigation"
    ? (zh ? "继续当前 Task" : "Continue task")
    : action.title;
  const bounds = action.requires_confirmation ? impactFromAction(action, impact) : null;

  if (!action.requires_confirmation) {
    return (
      <button
        type="button"
        onClick={() => onRun(action)}
        title={action.reason || label}
        data-testid="agent-next-action"
        className="inline-flex max-w-full animate-fade-in items-center gap-1.5 rounded-lg border border-edge bg-panel/60 px-3 py-1.5 text-xs text-gray-300 transition-colors hover:border-accent/45 hover:bg-accent-dim/60 hover:text-gray-100"
      >
        <span className="truncate">{label}</span>
        <ArrowIcon />
      </button>
    );
  }

  const why = bounds?.why || action.reason;
  const movement = bounds && (bounds.file_count || bounds.total_bytes)
    ? [
        bounds.file_count != null ? (zh ? `${bounds.file_count} 个文件` : `${bounds.file_count} file${bounds.file_count === 1 ? "" : "s"}`) : null,
        bounds.total_bytes != null ? formatBytes(bounds.total_bytes) : null,
      ].filter(Boolean).join(" · ")
    : null;

  return (
    <section
      data-testid="agent-decision-required"
      className="w-full max-w-[min(46rem,100%)] animate-fade-in rounded-xl border border-warn-border bg-warn-bg/45 p-3.5"
      aria-label={zh ? "需要你的决定" : "Decision required"}
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0 text-warn-fg"><DecisionIcon /></span>
        <div className="min-w-0 flex-1">
          <div className="text-2xs font-semibold uppercase tracking-[0.08em] text-warn-fg">
            {zh ? "Decision required · 需要你的决定" : "Decision required"}
          </div>
          <div className="mt-1 text-sm font-medium text-gray-100">{label}</div>
          {why ? <p className="mt-1.5 text-sm leading-relaxed text-gray-300">{why}</p> : null}
          {bounds ? (
            <dl data-testid="decision-impact" className="mt-3 grid gap-2 rounded-lg border border-warn-border/60 bg-canvas/30 px-3 py-2.5 text-xs text-gray-400">
              {bounds.gate === "cloud_download" ? (
                <div>
                  <dt className="text-2xs font-semibold uppercase tracking-[0.08em] text-gray-500">{zh ? "影响" : "Impact"}</dt>
                  <dd className="mt-0.5">{zh ? "确认后将按计划下载对象到本机；未确认不会移动数据。" : "Confirmation opens a bounded download plan. Nothing moves until you confirm."}</dd>
                </div>
              ) : bounds.gate === "artifact_write" ? (
                <div>
                  <dt className="text-2xs font-semibold uppercase tracking-[0.08em] text-gray-500">{zh ? "影响" : "Impact"}</dt>
                  <dd className="mt-0.5">{zh ? "确认后写入一份已脱敏的报告。" : "Confirmation writes a sanitized report artifact."}</dd>
                </div>
              ) : null}
              {bounds.bucket ? (
                <div>
                  <dt className="text-2xs font-semibold uppercase tracking-[0.08em] text-gray-500">{zh ? "范围" : "Scope"}</dt>
                  <dd className="mt-0.5 font-mono text-2xs text-gray-300">{bounds.bucket}{bounds.prefix ? ` / ${bounds.prefix}` : ""}{bounds.source_type ? ` · ${bounds.source_type}` : ""}</dd>
                </div>
              ) : null}
              {bounds.scan_scope && !bounds.bucket ? (
                <div>
                  <dt className="text-2xs font-semibold uppercase tracking-[0.08em] text-gray-500">{zh ? "扫描" : "Scan"}</dt>
                  <dd className="mt-0.5">{bounds.scan_scope}</dd>
                </div>
              ) : null}
              {movement ? (
                <div data-testid="decision-movement">
                  <dt className="text-2xs font-semibold uppercase tracking-[0.08em] text-gray-500">{zh ? "预计移动" : "Will move"}</dt>
                  <dd className="mt-0.5 tabular-nums">{movement}</dd>
                </div>
              ) : null}
            </dl>
          ) : null}
          <div className="mt-3.5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onRun(action)}
              data-testid="agent-approve-action"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-semibold text-accent-fg transition-[background-color,transform] duration-fast hover:bg-accent-soft active:scale-[.98]"
            >
              {zh ? "审阅并继续" : "Review & continue"}
              <ArrowIcon />
            </button>
            {onDecline ? (
              <button
                type="button"
                onClick={() => onDecline(action)}
                data-testid="agent-decline-action"
                className="inline-flex h-8 items-center rounded-lg border border-edge px-3 text-xs text-gray-300 transition-[border-color,color,transform] duration-fast hover:border-edge-strong hover:text-gray-100 active:scale-[.98]"
              >
                {zh ? "拒绝" : "Decline"}
              </button>
            ) : null}
            <span className="text-2xs text-gray-500">
              {zh ? "Agent 会在你明确决定前停在这里" : "The Agent waits for your explicit decision"}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
