import type { NextAction, TriageCase } from "../types";
import { useI18n } from "../i18n";
import { AgentNextAction } from "./AgentDecisionCard";

const CONF_PILL: Record<string, string> = {
  high: "bg-accent/15 text-accent-soft",
  medium: "bg-warn-bg text-warn-fg",
  low: "bg-gray-500/40 text-gray-400",
};

/** Deterministic offline error triage produced by the runtime. */
export function TriageCard({ c, onRun }: { c: TriageCase; onRun?: (action: NextAction) => void }) {
  const { lang } = useI18n();
  const copy = lang === "zh"
    ? { title: "Error Triage · 错误诊断", next: "下一步", actions: "接下来可以做" }
    : { title: "Error triage", next: "next", actions: "Next checks" };
  return (
    <div className="animate-fade-in-up overflow-hidden rounded-xl border border-edge bg-panel/60" data-testid="agent-triage-artifact">
      <div className="flex items-center gap-2 border-b border-edge/70 px-3.5 py-2">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent-soft" aria-hidden>
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <span className="text-2xs font-medium uppercase tracking-wider text-gray-500">{copy.title}</span>
      </div>
      <div className="px-3.5 py-3 text-sm">
        <div className="text-gray-200">{c.summary}</div>
        <ul className="mt-2.5 space-y-1.5">
          {c.candidate_causes.map((cause, index) => (
            <li key={index} className="flex items-start gap-2 text-xs">
              <span className={`mt-px shrink-0 rounded px-1.5 py-0.5 text-2xs font-medium ${CONF_PILL[cause.confidence ?? "low"] ?? "bg-gray-500/40 text-gray-400"}`}>{cause.confidence}</span>
              <span className="min-w-0">
                <span className="text-gray-200">{cause.title}</span>
                {cause.next_checks?.length ? <span className="text-gray-500"> — {copy.next}: {cause.next_checks.slice(0, 3).join("; ")}</span> : null}
              </span>
            </li>
          ))}
        </ul>
        {onRun && c.safe_next_actions?.length ? (
          <div className="mt-3 border-t border-edge/60 pt-2.5">
            <span className="text-2xs text-gray-500">{copy.actions}</span>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {c.safe_next_actions.map((action, index) => <AgentNextAction key={`${action.action_type}-${index}`} action={action} onRun={onRun} />)}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
