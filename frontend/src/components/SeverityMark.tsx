import { useI18n } from "../i18n";

const KNOWN_SEVERITIES = new Set(["info", "low", "medium", "high", "critical"]);
const KNOWN_CONFIDENCES = new Set(["low", "medium", "high"]);

/** Localize a backend severity/confidence token; unknown values pass through. */
export function severityLabel(severity: string | null | undefined, t: (key: string) => string): string {
  const s = (severity || "").toLowerCase();
  return KNOWN_SEVERITIES.has(s) ? t(`severity.${s}`) : severity || "info";
}

export function confidenceLabel(confidence: string | null | undefined, t: (key: string) => string): string {
  const s = (confidence || "").toLowerCase();
  return KNOWN_CONFIDENCES.has(s) ? t(`confidence.${s}`) : confidence || "";
}

/** One severity mark: the status dot plus a localized label. */
export function SeverityMark({ severity }: { severity?: string | null }) {
  const { t } = useI18n();
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="agent-review-list-dot shrink-0" data-severity={(severity || "info").toLowerCase()} aria-hidden />
      <span>{severityLabel(severity, t)}</span>
    </span>
  );
}
