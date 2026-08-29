import type { SessionDetail } from "../types";
import { EvidenceReview } from "./EvidenceReview";
import { ReportArtifact } from "./ReportArtifact";
import { ExecutionReview } from "./ExecutionReview";
import type { ReviewSurface } from "./model";
import { useWorkbenchCopy } from "./copy";

export function AgentReviewPanel({
  view,
  detail,
  report,
  reportLoading,
  error,
  selectedRunId,
  onView,
  onOpenRun,
  onCloseRun,
  onClose,
}: {
  view: ReviewSurface;
  detail: SessionDetail | null;
  report: string | null;
  reportLoading: boolean;
  error: string | null;
  selectedRunId: string | null;
  onView: (view: ReviewSurface) => void;
  onOpenRun: (runId: string) => void;
  onCloseRun: () => void;
  onClose: () => void;
}) {
  const copy = useWorkbenchCopy();
  const findingCount = detail?.findings.length ?? 0;
  const runCount = detail?.runs.filter((run) => run.origin !== "agent").length ?? 0;
  const memoryCount = detail?.agent_memory?.length ?? 0;

  return (
    <aside className="agent-review-panel" data-testid="agent-review-panel" aria-label={copy.review.title}>
      <header className="agent-review-header">
        <div className="min-w-0">
          <div className="agent-review-eyebrow">{copy.review.eyebrow}</div>
          <strong>{copy.review.title}</strong>
        </div>
        <button type="button" className="agent-review-close" onClick={onClose} aria-label={copy.review.close} title={copy.review.close}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </header>

      <nav className="agent-review-nav" aria-label={copy.review.navigate}>
        {(["overview", "evidence", "runs", "report"] as const).map((item) => (
          <button
            type="button"
            key={item}
            data-active={view === item ? "true" : "false"}
            onClick={() => onView(item)}
          >
            {copy.review.views[item]}
            {item === "evidence" && findingCount > 0 ? <span>{findingCount}</span> : null}
            {item === "runs" && runCount > 0 ? <span>{runCount}</span> : null}
          </button>
        ))}
      </nav>

      <div className="agent-review-body">
        {error ? <p className="agent-review-error">{error}</p> : null}

        {!error && view === "overview" ? (
          <div className="agent-review-overview">
            <section>
              <div className="agent-review-section-label">{copy.review.currentState}</div>
              <p className="agent-review-summary">
                {detail?.summary?.summary_md?.trim() || detail?.goal?.trim() || copy.review.noSummary}
              </p>
              <div className="agent-review-stats">
                <span>{copy.findings(findingCount)}</span>
                <span>{copy.runs(runCount)}</span>
                <span>{copy.review.memory(memoryCount)}</span>
              </div>
            </section>

            <section>
              <div className="agent-review-section-label">{copy.review.latestFindings}</div>
              {detail?.findings.length ? (
                <div className="agent-review-list">
                  {detail.findings.slice(0, 5).map((finding) => (
                    <button type="button" key={finding.id} onClick={() => onView("evidence")}>
                      <span className="agent-review-list-dot" data-severity={finding.severity ?? "info"} aria-hidden />
                      <span className="min-w-0">
                        <strong>{finding.title || copy.review.untitledFinding}</strong>
                        {finding.interpretation ? <small>{finding.interpretation}</small> : null}
                      </span>
                    </button>
                  ))}
                </div>
              ) : <p className="agent-review-empty">{copy.evidence.noFindings}</p>}
            </section>

            <section>
              <div className="agent-review-section-label">{copy.review.execution}</div>
              {detail?.runs.some((run) => run.origin !== "agent") ? (
                <div className="agent-review-list">
                  {detail.runs.filter((run) => run.origin !== "agent").slice(0, 5).map((run) => (
                    <button type="button" key={run.run_id} onClick={() => onOpenRun(run.run_id)}>
                      <span className="agent-review-list-dot" data-status={run.status} aria-hidden />
                      <span className="min-w-0">
                        <strong>{run.title || run.run_type}</strong>
                        <small>{run.status}</small>
                      </span>
                    </button>
                  ))}
                </div>
              ) : <p className="agent-review-empty">{copy.run.empty}</p>}
            </section>
          </div>
        ) : null}

        {!error && view === "evidence" ? (
          detail ? <EvidenceReview detail={detail} sessionId={detail.id} /> : <p className="agent-review-empty">{copy.review.loading}</p>
        ) : null}

        {!error && view === "runs" ? (
          <ExecutionReview detail={detail} selectedRunId={selectedRunId} onOpenRun={onOpenRun} onCloseRun={onCloseRun} />
        ) : null}

        {!error && view === "report" ? (
          <ReportArtifact report={report} loading={reportLoading} error={null} />
        ) : null}
      </div>
    </aside>
  );
}
