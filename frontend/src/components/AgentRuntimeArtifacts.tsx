import { useEffect, useState } from "react";
import type { Grounding, NextAction, SessionFinding, TriageCase } from "../types";
import { useI18n } from "../i18n";
import { WorkingRow } from "./LiveTrace";
import { ProposalCard } from "./AgentDecisionCard";

const CONF_PILL: Record<string, string> = {
  high: "bg-accent/15 text-accent-soft",
  medium: "bg-warn-bg text-warn-fg",
  low: "bg-gray-500/40 text-gray-400",
};

export function ThinkingBubble() {
  const { t } = useI18n();
  const labels = [t("think.0"), t("think.1"), t("think.2"), t("think.3")];
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setIndex((value) => (value + 1) % labels.length), 2200);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="animate-fade-in-up" data-testid="agent-working-placeholder">
      <div className="flex h-4 items-center" />
      <WorkingRow label={labels[index]} />
    </div>
  );
}

/** Reviewable provenance attached to a real Agent work result. */
export function GroundingCard({ g }: { g: Grounding }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const evidence = g.evidence_used ?? [];
  const gaps = g.evidence_gaps ?? [];
  const skills = g.skills_used ?? [];
  if (!evidence.length && !gaps.length && !skills.length) return null;
  const Section = ({ label, items, tone }: { label: string; items: string[]; tone: string }) => items.length ? (
    <div className="mt-1.5">
      <span className={`text-2xs font-medium uppercase tracking-wider ${tone}`}>{label}</span>
      <ul className="mt-0.5 space-y-0.5">
        {items.map((item, index) => <li key={index} className="text-xs text-gray-400">· {item}</li>)}
      </ul>
    </div>
  ) : null;
  return (
    <div className="animate-fade-in" data-testid="agent-grounding">
      <button type="button" onClick={() => setOpen((value) => !value)} className="flex items-center gap-1.5 text-2xs text-gray-500 transition-colors hover:text-gray-400">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`transition-transform ${open ? "rotate-90" : ""}`} aria-hidden><polyline points="9 18 15 12 9 6" /></svg>
        {t("grounding.title")}
        {gaps.length ? <span className="rounded bg-warn-bg px-1.5 py-0.5 text-2xs text-warn-fg">{gaps.length}</span> : null}
      </button>
      {open ? (
        <div className="mt-1 border-l border-edge/70 pl-3">
          <Section label={t("grounding.evidence")} items={evidence} tone="text-gray-500" />
          <Section label={t("grounding.gaps")} items={gaps} tone="text-warn-fg" />
          <Section label={t("grounding.skills")} items={skills} tone="text-accent-soft/80" />
        </div>
      ) : null}
    </div>
  );
}

const severityLabel = (t: (key: string) => string, severity: string): string => {
  const value = t(`metric.${severity}`);
  return value === `metric.${severity}` ? severity : value;
};

const FINDING_TONE: Record<string, string> = {
  critical: "text-danger",
  high: "text-danger",
  warning: "text-warn-fg",
  medium: "text-warn-fg",
  opportunity: "text-accent-soft/90",
  low: "text-gray-400",
  info: "text-gray-400",
};

export function FindingsCard({ findings }: { findings: SessionFinding[] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const items = (findings ?? []).filter((finding) => finding.title || finding.interpretation);
  if (!items.length) return null;
  return (
    <div className="animate-fade-in rounded-lg border border-edge bg-panel/60 p-3" data-testid="agent-findings">
      <button type="button" onClick={() => setOpen((value) => !value)} className="flex w-full items-center gap-1.5 text-xs font-medium text-gray-300 transition-colors hover:text-gray-100">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`transition-transform ${open ? "rotate-90" : ""}`} aria-hidden><polyline points="9 18 15 12 9 6" /></svg>
        {t("findings.title")}
        <span className="rounded bg-elevated px-1.5 py-0.5 text-2xs text-gray-400">{items.length}</span>
      </button>
      {open ? (
        <ul className="mt-2 space-y-1.5 border-l border-edge/70 pl-3">
          {items.map((finding) => (
            <li key={finding.id} className="text-xs">
              <div className="flex items-baseline gap-1.5">
                <span className={`text-2xs font-medium uppercase tracking-wider ${FINDING_TONE[(finding.severity || finding.kind || "info").toLowerCase()] || "text-gray-400"}`}>
                  {severityLabel(t, (finding.severity || finding.kind || "info").toLowerCase())}
                </span>
                <span className="text-gray-200">{finding.title || "—"}</span>
              </div>
              {finding.interpretation ? <p className="mt-0.5 text-gray-400">{finding.interpretation}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Deterministic offline error triage produced by the runtime. */
export function TriageCard({ c, onRun }: { c: TriageCase; onRun?: (proposal: NextAction) => void }) {
  const { t } = useI18n();
  return (
    <div className="animate-fade-in-up overflow-hidden rounded-xl border border-edge bg-panel/60" data-testid="agent-triage-artifact">
      <div className="flex items-center gap-2 border-b border-edge/70 px-3.5 py-2">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent-soft" aria-hidden>
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <span className="text-2xs font-medium uppercase tracking-wider text-gray-500">{t("triage.title")}</span>
      </div>
      <div className="px-3.5 py-3 text-sm">
        <div className="text-gray-200">{c.summary}</div>
        <ul className="mt-2.5 space-y-1.5">
          {c.candidate_causes.map((cause, index) => (
            <li key={index} className="flex items-start gap-2 text-xs">
              <span className={`mt-px shrink-0 rounded px-1.5 py-0.5 text-2xs font-medium ${CONF_PILL[cause.confidence ?? "low"] ?? "bg-gray-500/40 text-gray-400"}`}>{cause.confidence}</span>
              <span className="min-w-0">
                <span className="text-gray-200">{cause.title}</span>
                {cause.next_checks?.length ? <span className="text-gray-500"> — {t("proposal.next")}: {cause.next_checks.slice(0, 3).join("; ")}</span> : null}
              </span>
            </li>
          ))}
        </ul>
        {onRun && c.safe_next_actions?.length ? (
          <div className="mt-3 border-t border-edge/60 pt-2.5">
            <span className="text-2xs text-gray-500">{t("thread.suggestedNext")}</span>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {c.safe_next_actions.map((proposal, index) => <ProposalCard key={`${proposal.action_type}-${index}`} proposal={proposal} onRun={onRun} />)}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
