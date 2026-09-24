import { useI18n } from "../i18n";
import { approvalActionLabel } from "../lib/approvalAction";
import { fmtBytes } from "../lib/format";
import type { ApprovalItem } from "../lib/turnItems";
import { Icon } from "./icons";

export type ApprovalResolution = "approved" | "declined";

type TFunc = ReturnType<typeof useI18n>["t"];

/** The server's bounded-scope line (`prefix p; max N files; max N bytes;
 * up to N buckets`) in the UI language with human sizes (v1.19). A part this
 * build does not recognise is kept verbatim rather than dropped. The prefix
 * part is omitted when the card already shows the prefix on its own row. */
export function formatScanScope(scope: string, t: TFunc, shownPrefix?: string | null): string {
  return scope
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      let m = /^prefix (.+)$/.exec(part);
      if (m) return shownPrefix && m[1] === shownPrefix ? null : t("approval.scopePrefix", { p: m[1] });
      m = /^max (\d+) files$/.exec(part);
      if (m) return t("approval.scopeFiles", { n: Number(m[1]).toLocaleString() });
      m = /^max (\d+) bytes$/.exec(part);
      if (m) return t("approval.scopeBytes", { size: fmtBytes(Number(m[1])) ?? `${m[1]} B` });
      m = /^up to (\d+) buckets$/.exec(part);
      if (m) return t("approval.scopeBuckets", { n: Number(m[1]).toLocaleString() });
      return part;
    })
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

/** The gate's own explanation in the UI language; the server's sentence is
 * the fallback for a gate this build does not know. */
function gateWhy(gate: string | undefined, fallback: string | null | undefined, t: TFunc): string | null {
  if (gate === "cloud_download") return t("approval.whyDownload");
  return fallback || null;
}
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
  // v1.16 — a missing title falls back to the localized gate name, never
  // raw snake_case (both current gates always send titles; this is the net).
  const title = item.title || approvalActionLabel(item.action_type, t);
  const files = impact?.file_count != null ? t("approval.fileCount", { n: impact.file_count }) : null;
  const bytes = impact?.total_bytes != null ? fmtBytes(impact.total_bytes) : null;
  // v1.13 — large-scan gate: buckets + estimated live calls.
  const scanCalls = impact?.estimated_calls != null
    ? t("approval.estimatedCalls", { buckets: impact.buckets ?? "—", calls: impact.estimated_calls })
    : null;
  const why = impact ? gateWhy(impact.gate, impact.why || item.reason, t) : item.reason;
  const scope = impact?.scan_scope ? formatScanScope(impact.scan_scope, t, impact.prefix) : "";
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
          {scope ? (<><dt>{t("approval.scope")}</dt><dd className="tabular-nums" data-testid="approval-scope">{scope}</dd></>) : null}
          {scanCalls ? (<><dt>{t("approval.scanCalls")}</dt><dd className="tabular-nums" data-testid="approval-scan-calls">{scanCalls}</dd></>) : null}
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
            title={t("approval.allowTaskHint")}
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
