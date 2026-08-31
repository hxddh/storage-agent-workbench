import type { SessionDetail } from "../types";
import { EvidenceReview } from "./EvidenceReview";
import { ReportArtifact } from "./ReportArtifact";
import { ExecutionReview } from "./ExecutionReview";
import type { ReviewSurface } from "./model";
import { useAgentCopy } from "./agentCopy";
import type { TaskProvenance } from "../viz/types";

export function AgentReviewPanel({
  view,
  detail,
  report,
  reportLoading,
  error,
  selectedExecutionId,
  selectedFindingId,
  provenance = null,
  onOpenExecution,
  onCloseExecution,
  onClose,
}: {
  view: ReviewSurface;
  detail: SessionDetail | null;
  report: string | null;
  reportLoading: boolean;
  error: string | null;
  selectedExecutionId: string | null;
  selectedFindingId?: string | null;
  provenance?: TaskProvenance | null;
  onOpenExecution: (executionId: string) => void;
  onCloseExecution: () => void;
  onClose: () => void;
}) {
  const copy = useAgentCopy();
  const title = view === "evidence"
    ? copy.evidence.eyebrow
    : view === "execution"
      ? copy.execution.title
      : copy.report.title;

  return (
    <aside className="agent-review-panel" data-testid="agent-review-panel" aria-label={title}>
      <header className="agent-review-header">
        <div className="min-w-0">
          <div className="agent-review-eyebrow">{copy.review.eyebrow}</div>
          <strong>{title}</strong>
        </div>
        <button type="button" className="agent-review-close" onClick={onClose} aria-label={copy.review.close} title={copy.review.close}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </header>

      <div className="agent-review-body">
        {error ? <p className="agent-review-error">{error}</p> : null}

        {!error && view === "evidence" ? (
          detail ? <EvidenceReview detail={detail} sessionId={detail.id} selectedFindingId={selectedFindingId ?? null} provenance={provenance} /> : <p className="agent-review-empty">{copy.review.loading}</p>
        ) : null}

        {!error && view === "execution" ? (
          <ExecutionReview
            detail={detail}
            selectedExecutionId={selectedExecutionId}
            onOpenExecution={onOpenExecution}
            onCloseExecution={onCloseExecution}
          />
        ) : null}

        {!error && view === "report" ? (
          <ReportArtifact report={report} loading={reportLoading} error={null} />
        ) : null}
      </div>
    </aside>
  );
}
