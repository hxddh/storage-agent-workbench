import type { SessionDetail } from "../types";
import { ExecutionDetail } from "../components/ExecutionDetail";
import { useAgentCopy } from "./agentCopy";

/** Contextual execution history for the active Agent task. */
export function ExecutionReview({
  detail,
  selectedExecutionId,
  onOpenExecution,
  onCloseExecution,
}: {
  detail: SessionDetail | null;
  selectedExecutionId: string | null;
  onOpenExecution: (executionId: string) => void;
  onCloseExecution: () => void;
}) {
  const copy = useAgentCopy();
  if (selectedExecutionId) {
    return <ExecutionDetail runId={selectedExecutionId} onBack={onCloseExecution} />;
  }

  const executions = detail?.runs ?? [];
  return (
    <article className="agent-document" data-testid="execution-review">
      <header className="agent-document-heading">
        <p className="agent-eyebrow">{copy.execution.eyebrow}</p>
        <h1>{copy.execution.title}</h1>
        <p>{copy.execution.description}</p>
      </header>
      {executions.length === 0 ? (
        <p className="agent-empty-line">{copy.execution.empty}</p>
      ) : (
        <div className="agent-run-list">
          {executions.map((execution) => (
            <button
              key={execution.run_id}
              type="button"
              className="agent-run-row"
              onClick={() => onOpenExecution(execution.run_id)}
            >
              <span className="agent-run-status" data-status={execution.status} aria-hidden />
              <span className="agent-run-main">
                <strong>{execution.title || execution.run_type}</strong>
                <small>{execution.run_type}{execution.origin ? ` · ${execution.origin}` : ""}</small>
              </span>
              <span className="agent-run-state">{execution.status}</span>
              <span aria-hidden className="agent-run-arrow">→</span>
            </button>
          ))}
        </div>
      )}
    </article>
  );
}
