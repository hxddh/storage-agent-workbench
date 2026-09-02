import type { SessionDetail } from "../types";
import { EvidenceReview } from "./EvidenceReview";
import { ReportArtifact } from "./ReportArtifact";
import { ExecutionReview } from "./ExecutionReview";
import type { ReviewSurface } from "./model";
import { useAgentCopy } from "./agentCopy";
import type { TaskProvenance } from "../viz/types";
import { useDismissOnEscape } from "../hooks/useDismissOnEscape";
import { Icon } from "../components/icons";

/** Review is a sheet over the Task: title, close, the requested artifact. */
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

  useDismissOnEscape(true, onClose);

  return (
    <div className="agent-review-overlay" data-testid="agent-review-overlay" onClick={onClose}>
      <aside
        className="agent-review-panel"
        data-testid="agent-review-panel"
        role="dialog"
        aria-modal="false"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="agent-review-header">
          <strong>{title}</strong>
          <button type="button" className="agent-review-close" onClick={onClose} aria-label={copy.review.close} title={copy.review.close}>
            <Icon name="close" size={15} />
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
    </div>
  );
}
