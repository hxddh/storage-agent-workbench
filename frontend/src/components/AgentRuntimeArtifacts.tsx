import type { TriageCase } from "../types";
import { useI18n } from "../i18n";
import { confidenceLabel } from "./SeverityMark";
import { Icon } from "./icons";

const CONFIDENCE = new Set(["high", "medium", "low"]);

/** Deterministic offline error triage produced by the runtime: findings only. */
export function TriageCard({ c }: { c: TriageCase }) {
  const { t } = useI18n();
  // v1.16 — triage title lives in the i18n dict.
  const copy = { title: t("triage.title"), next: t("triage.next") };
  return (
    <div className="turn-agent" data-testid="agent-triage-artifact">
      <div className="triage-head">
        <Icon name="alert" size={14} />
        <span>{copy.title}</span>
      </div>
      <div className="triage-summary">{c.summary}</div>
      <ul className="triage-causes">
        {c.candidate_causes.map((cause, index) => (
          <li key={index}>
            <span className="triage-confidence" data-confidence={CONFIDENCE.has(cause.confidence ?? "") ? cause.confidence : "low"}>{confidenceLabel(cause.confidence, t)}</span>
            <span className="min-w-0">
              <span className="triage-cause-title">{cause.title}</span>
              {cause.next_checks?.length ? <span className="triage-next"> — {copy.next}: {cause.next_checks.slice(0, 3).join("; ")}</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
