import { useI18n } from "../i18n";
import { Badge, StatusDot } from "./ui";

interface Row {
  label: string;
  value: string;
}

/**
 * Displays the sanitized result of a read-only tool call. Error messages are
 * shown exactly as the backend sanitized them — never raw.
 */
export function ToolResultCard({
  title,
  success,
  rows,
  errorCode,
  errorMessage,
}: {
  title: string;
  success: boolean;
  rows: Row[];
  errorCode?: string | null;
  errorMessage?: string | null;
}) {
  const { t } = useI18n();
  return (
    <div className="tool-result-card" data-testid="tool-result-card">
      <div className="tool-result-head">
        <StatusDot tone={success ? "success" : "danger"} />
        <span className="tool-result-title">{title}</span>
        <Badge tone={success ? "success" : "danger"}>
          {success ? t("tool.success") : t("tool.failed")}
        </Badge>
      </div>

      {rows.length > 0 && (
        <dl className="tool-result-rows">
          {rows.map((r) => (
            <div key={r.label}>
              <dt>{r.label}</dt>
              <dd title={r.value}>{r.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {!success && (errorCode || errorMessage) && (
        <div className="tool-result-error">
          {errorCode && <div className="tool-result-error-code">{errorCode}</div>}
          {errorMessage && <div>{errorMessage}</div>}
        </div>
      )}
    </div>
  );
}
