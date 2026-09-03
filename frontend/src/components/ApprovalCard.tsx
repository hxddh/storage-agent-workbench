import { useI18n } from "../i18n";
import { fmtBytes } from "../lib/format";
import type { ApprovalItem } from "../lib/turnItems";
import { Icon } from "./icons";

export type ApprovalResolution = "approved" | "declined";
export type ApprovalScope = "once" | "task";

/**
 * An inline approval raised by a gated tool call (v1.11). The execution is
 * parked on this card until the user decides; Allow resumes the SAME execution
 * with the tool's real result, Deny returns a structured refusal to the model.
 */
export function ApprovalCard({
  item,
  onResolve,
  busy = false,
}: {
  item: ApprovalItem;
  onResolve?: (decisionId: string, resolution: ApprovalResolution, scope: ApprovalScope) => void;
  busy?: boolean;
}) {
  const { t } = useI18n();
  const impact = item.impact;
  const pending = item.status === "pending";
  const title = item.title || item.action_type;
  const files = impact?.file_count != null ? t("approval.fileCount", { n: impact.file_count }) : null;
  const bytes = impact?.total_bytes != null ? fmtBytes(impact.total_bytes) : null;
  const why = impact?.why || item.reason;
  const resolved = item.status === "approved"
    ? (item.scope === "task" ? t("approval.allowedTask") : t("approval.allowed"))
    : item.status === "declined" ? t("approval.denied")
      : item.status === "granted"
        ? (item.policy === "session" ? t("approval.policySession")
          : item.policy === "always" ? t("approval.policyAlways")
            : item.policy === "task" ? t("approval.policyTask") : t("approval.granted"))
        : item.status === "superseded" ? t("approval.superseded") : null;

  return (
    <section
      className="approval-card"
      data-testid="approval-card"
      data-status={item.status}
      data-action-type={item.action_type}
      data-policy={item.policy ?? undefined}
      aria-label={t("approval.eyebrow")}
    >
      <div className="approval-card-head">
        <Icon name="shield" size={13} />
        <span>{t("approval.eyebrow")}</span>
      </div>
      <h3 className="approval-card-title">{title}</h3>
      {pending && impact ? (
        <dl className="approval-card-impact" data-testid="approval-impact">
          {impact.bucket ? (<><dt>{t("approval.bucket")}</dt><dd data-mono="true">{impact.bucket}</dd></>) : null}
          {impact.prefix ? (<><dt>{t("approval.prefix")}</dt><dd data-mono="true">{impact.prefix}</dd></>) : null}
          {files || bytes ? (
            <><dt>{t("approval.moves")}</dt><dd className="tabular-nums" data-testid="approval-movement">{[files, bytes].filter(Boolean).join(" · ")}</dd></>
          ) : null}
          {impact.scan_scope ? (<><dt>{t("approval.scope")}</dt><dd>{impact.scan_scope}</dd></>) : null}
          {why ? (<><dt>{t("approval.why")}</dt><dd>{why}</dd></>) : null}
          {impact.warnings?.length ? (
            <><dt>{t("approval.warnings")}</dt><dd>{impact.warnings.join("; ")}</dd></>
          ) : null}
        </dl>
      ) : pending && why ? (
        <p className="approval-card-why">{why}</p>
      ) : null}
      {pending ? (
        <div className="approval-card-actions">
          <button
            type="button"
            className="native-chip"
            data-tone="primary"
            data-testid="approval-allow"
            disabled={busy || !onResolve}
            onClick={() => onResolve?.(item.decision_id, "approved", "once")}
          >
            {t("approval.allow")}
          </button>
          <button
            type="button"
            className="native-chip"
            data-testid="approval-allow-task"
            disabled={busy || !onResolve}
            onClick={() => onResolve?.(item.decision_id, "approved", "task")}
          >
            {t("approval.allowTask")}
          </button>
          <button
            type="button"
            className="native-chip"
            data-testid="approval-deny"
            disabled={busy || !onResolve}
            onClick={() => onResolve?.(item.decision_id, "declined", "once")}
          >
            {t("approval.deny")}
          </button>
          <small>{busy ? t("approval.sending") : t("approval.waits")}</small>
        </div>
      ) : (
        <p className="approval-card-resolved" data-testid="approval-resolved">
          <Icon name={item.status === "declined" ? "x" : "check"} size={12} />
          {resolved}
        </p>
      )}
    </section>
  );
}
