import type { SessionDetail } from "../types";
import { RunDetail } from "../components/RunDetail";
import { useAgentCopy } from "./agentCopy";

/** Contextual execution history for the active Agent task. */
export function ExecutionReview({
  detail,
  selectedRunId,
  onOpenRun,
  onCloseRun,
}: {
  detail: SessionDetail | null;
  selectedRunId: string | null;
  onOpenRun: (runId: string) => void;
  onCloseRun: () => void;
}) {
  const copy = useAgentCopy();
  if (selectedRunId) {
    return <RunDetail runId={selectedRunId} onBack={onCloseRun} />;
  }

  const runs = detail?.runs ?? [];
  return (
    <article className="agent-document" data-testid="execution-review">
      <header className="agent-document-heading">
        <p className="agent-eyebrow">{copy.run.eyebrow}</p>
        <h1>{copy.run.title}</h1>
        <p>{copy.run.description}</p>
      </header>
      {runs.length === 0 ? (
        <p className="agent-empty-line">{copy.run.empty}</p>
      ) : (
        <div className="agent-run-list">
          {runs.map((run) => (
            <button
              key={run.run_id}
              type="button"
              className="agent-run-row"
              onClick={() => onOpenRun(run.run_id)}
            >
              <span className="agent-run-status" data-status={run.status} aria-hidden />
              <span className="agent-run-main">
                <strong>{run.title || run.run_type}</strong>
                <small>{run.run_type}{run.origin ? ` · ${run.origin}` : ""}</small>
              </span>
              <span className="agent-run-state">{run.status}</span>
              <span aria-hidden className="agent-run-arrow">→</span>
            </button>
          ))}
        </div>
      )}
    </article>
  );
}
