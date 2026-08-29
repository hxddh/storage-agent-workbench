import type { NextAction } from "../types";
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

/** A real Agent decision boundary backed by the backend confirmation contract. */
export function ProposalCard({
  proposal,
  onRun,
}: {
  proposal: NextAction;
  onRun: (proposal: NextAction) => void;
}) {
  const { lang } = useI18n();
  const label = proposal.action_type === "continue_investigation"
    ? (lang === "zh" ? "继续当前 Task" : "Continue task")
    : proposal.title;

  if (!proposal.requires_confirmation) {
    return (
      <button
        type="button"
        onClick={() => onRun(proposal)}
        title={proposal.reason || label}
        data-testid="agent-next-action"
        className="inline-flex max-w-full animate-fade-in items-center gap-1.5 rounded-lg border border-edge bg-panel/60 px-3 py-1.5 text-xs text-gray-300 transition-colors hover:border-accent/45 hover:bg-accent-dim/60 hover:text-gray-100"
      >
        <span className="truncate">{label}</span>
        <ArrowIcon />
      </button>
    );
  }

  return (
    <section
      data-testid="agent-decision-required"
      className="w-full max-w-[min(46rem,100%)] animate-fade-in rounded-xl border border-warn-border bg-warn-bg/45 p-3.5"
      aria-label={lang === "zh" ? "需要你的决定" : "Decision required"}
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0 text-warn-fg"><DecisionIcon /></span>
        <div className="min-w-0 flex-1">
          <div className="text-2xs font-semibold uppercase tracking-[0.08em] text-warn-fg">
            {lang === "zh" ? "Decision required · 需要你的决定" : "Decision required"}
          </div>
          <div className="mt-1 text-sm font-medium text-gray-100">{label}</div>
          {proposal.reason ? <p className="mt-1 text-xs leading-relaxed text-gray-400">{proposal.reason}</p> : null}
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => onRun(proposal)}
              data-testid="agent-approve-action"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-semibold text-accent-fg transition-colors hover:bg-accent-soft"
            >
              {lang === "zh" ? "审阅并继续" : "Review & continue"}
              <ArrowIcon />
            </button>
            <span className="text-2xs text-gray-500">
              {lang === "zh" ? "Agent 会在你明确决定前停在这里" : "The Agent waits for your explicit decision"}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
