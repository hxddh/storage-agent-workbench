import type { NextAction, TriageCase } from "../types";
import { useI18n } from "../i18n";
import { AgentNextAction } from "./AgentDecisionCard";
import { Icon } from "./icons";

const CONF_CLASS: Record<string, string> = {
  high: "text-gray-100",
  medium: "text-warn-fg",
  low: "text-gray-500",
};

/** Deterministic offline error triage produced by the runtime. */
export function TriageCard({ c, onRun }: { c: TriageCase; onRun?: (action: NextAction) => void }) {
  const { lang } = useI18n();
  const copy = lang === "zh"
    ? { title: "错误诊断 · Error triage", next: "下一步", actions: "接下来可以做" }
    : { title: "Error triage", next: "next", actions: "Next checks" };
  return (
    <div className="native-result" data-testid="agent-triage-artifact">
      <div className="mb-2 flex items-center gap-2 text-xs text-gray-500">
        <Icon name="alert" size={13} />
        <span>{copy.title}</span>
      </div>
      <div className="max-w-[46rem] text-prose text-gray-100">{c.summary}</div>
      <ul className="mt-3 max-w-[46rem] space-y-2">
        {c.candidate_causes.map((cause, index) => (
          <li key={index} className="flex items-start gap-3 text-sm">
            <span className={`mt-0.5 w-14 shrink-0 text-2xs font-medium uppercase tracking-wide ${CONF_CLASS[cause.confidence ?? "low"] ?? "text-gray-500"}`}>{cause.confidence}</span>
            <span className="min-w-0">
              <span className="text-gray-200">{cause.title}</span>
              {cause.next_checks?.length ? <span className="text-gray-500"> — {copy.next}: {cause.next_checks.slice(0, 3).join("; ")}</span> : null}
            </span>
          </li>
        ))}
      </ul>
      {onRun && c.safe_next_actions?.length ? (
        <div className="native-result-foot">
          <span className="text-2xs text-gray-500">{copy.actions}</span>
          {c.safe_next_actions.map((action, index) => <AgentNextAction key={`${action.action_type}-${index}`} action={action} onRun={onRun} />)}
        </div>
      ) : null}
    </div>
  );
}
