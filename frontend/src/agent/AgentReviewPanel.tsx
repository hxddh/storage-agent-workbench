import type { TaskArtifact } from "../api";
import type { SessionDetail } from "../types";
import { EvidenceReview } from "./EvidenceReview";
import { ReportArtifact } from "./ReportArtifact";
import { ExecutionReview } from "./ExecutionReview";
import type { ReviewSurface } from "./model";
import { useAgentCopy } from "./agentCopy";

export function AgentReviewPanel({
  view,
  detail,
  artifacts = [],
  report,
  reportLoading,
  error,
  selectedExecutionId,
  onView,
  onOpenExecution,
  onCloseExecution,
  onClose,
}: {
  view: ReviewSurface;
  detail: SessionDetail | null;
  /** First-class durable Artifact index (reports, evidence imports, analyses). */
  artifacts?: TaskArtifact[];
  report: string | null;
  reportLoading: boolean;
  error: string | null;
  selectedExecutionId: string | null;
  onView: (view: ReviewSurface) => void;
  onOpenExecution: (executionId: string) => void;
  onCloseExecution: () => void;
  onClose: () => void;
}) {
  const copy = useAgentCopy();
  const findingCount = detail?.findings.length ?? 0;
  const executionCount = detail?.runs.filter((execution) => execution.origin !== "agent").length ?? 0;
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
        {(["overview", "evidence", "execution", "report"] as const).map((item) => (
          <button
            type="button"
            key={item}
            data-active={view === item ? "true" : "false"}
            onClick={() => onView(item)}
          >
            {copy.review.views[item]}
            {item === "evidence" && findingCount > 0 ? <span>{findingCount}</span> : null}
            {item === "execution" && executionCount > 0 ? <span>{executionCount}</span> : null}
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
                <span>{copy.executions(executionCount)}</span>
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
              {detail?.runs.some((execution) => execution.origin !== "agent") ? (
                <div className="agent-review-list">
                  {detail.runs.filter((execution) => execution.origin !== "agent").slice(0, 5).map((execution) => (
                    <button type="button" key={execution.run_id} onClick={() => onOpenExecution(execution.run_id)}>
                      <span className="agent-review-list-dot" data-status={execution.status} aria-hidden />
                      <span className="min-w-0">
                        <strong>{execution.title || execution.run_type}</strong>
                        <small>{execution.status}</small>
                      </span>
                    </button>
                  ))}
                </div>
              ) : <p className="agent-review-empty">{copy.execution.empty}</p>}
            </section>

            <section>
              <div className="agent-review-section-label">{copy.review.artifacts}</div>
              {artifacts.length ? (
                <div className="agent-review-list" data-testid="task-artifacts">
                  {artifacts.slice(0, 8).map((artifact) => (
                    <button
                      type="button"
                      key={artifact.id}
                      onClick={() => {
                        if (artifact.artifact_type === "report" && artifact.ref_kind === "session_report") onView("report");
                        else if (artifact.ref_kind === "run" && artifact.ref_id) onOpenExecution(artifact.ref_id);
                        else onView("evidence");
                      }}
                    >
                      <span className="agent-review-list-dot" data-artifact={artifact.artifact_type} aria-hidden />
                      <span className="min-w-0">
                        <strong>{artifact.title || artifact.artifact_type}</strong>
                        {artifact.summary ? <small>{artifact.summary}</small> : null}
                      </span>
                    </button>
                  ))}
                </div>
              ) : <p className="agent-review-empty">{copy.review.noArtifacts}</p>}
            </section>
          </div>
        ) : null}

        {!error && view === "evidence" ? (
          detail ? <EvidenceReview detail={detail} sessionId={detail.id} /> : <p className="agent-review-empty">{copy.review.loading}</p>
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
