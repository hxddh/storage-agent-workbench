import type { NextAction } from "../types";
import type { DecisionImpact } from "../api";
import { useI18n } from "../i18n";
import { Icon } from "./icons";

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

/**
 * A real Agent next-action boundary backed by the backend confirmation contract.
 * A confirmation-gated action renders as an approval the Agent waits on.
 */
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
    ? (zh ? "继续当前任务" : "Continue task")
    : action.title;
  const bounds = action.requires_confirmation ? impactFromAction(action, impact) : null;

  if (!action.requires_confirmation) {
    return (
      <button
        type="button"
        onClick={() => onRun(action)}
        title={action.reason || label}
        data-testid="agent-next-action"
        className="native-chip max-w-full"
      >
        <span className="truncate">{label}</span>
        <Icon name="arrowRight" size={12} />
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
  const gateCopy = bounds?.gate === "cloud_download"
    ? (zh ? "批准后打开一个有上限的下载计划；确认前不会移动任何数据。" : "Approval opens a bounded download plan. Nothing moves until you confirm that plan.")
    : bounds?.gate === "artifact_write"
      ? (zh ? "批准后写入一份已脱敏的报告产物。" : "Approval writes a sanitized report artifact.")
      : null;

  return (
    <section
      data-testid="agent-decision-required"
      className="native-decision"
      aria-label={zh ? "需要你的决定" : "Decision required"}
    >
      <div className="native-decision-eyebrow">
        <Icon name="shield" size={13} />
        {zh ? "需要决定 · Decision required" : "Decision required"}
      </div>
      <h3 className="native-decision-title">{label}</h3>
      {why ? <p className="native-decision-why">{why}</p> : null}
      {bounds ? (
        <dl data-testid="decision-impact" className="native-decision-impact">
          {gateCopy ? (
            <>
              <dt>{zh ? "影响" : "Impact"}</dt>
              <dd>{gateCopy}</dd>
            </>
          ) : null}
          {bounds.bucket ? (
            <>
              <dt>{zh ? "范围" : "Scope"}</dt>
              <dd data-mono="true">{bounds.bucket}{bounds.prefix ? ` / ${bounds.prefix}` : ""}{bounds.source_type ? ` · ${bounds.source_type}` : ""}</dd>
            </>
          ) : null}
          {bounds.scan_scope && !bounds.bucket ? (
            <>
              <dt>{zh ? "扫描" : "Scan"}</dt>
              <dd>{bounds.scan_scope}</dd>
            </>
          ) : null}
          {movement ? (
            <>
              <dt>{zh ? "预计移动" : "Will move"}</dt>
              <dd data-testid="decision-movement" className="tabular-nums">{movement}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
      <div className="native-decision-actions">
        <button
          type="button"
          onClick={() => onRun(action)}
          data-testid="agent-approve-action"
          className="native-chip"
          data-tone="primary"
        >
          {zh ? "批准" : "Approve"}
          <Icon name="arrowRight" size={12} />
        </button>
        {onDecline ? (
          <button
            type="button"
            onClick={() => onDecline(action)}
            data-testid="agent-decline-action"
            className="native-chip"
          >
            {zh ? "拒绝" : "Decline"}
          </button>
        ) : null}
        <small>{zh ? "Agent 在你明确决定前停在这里" : "The Agent waits here for your decision"}</small>
      </div>
    </section>
  );
}
