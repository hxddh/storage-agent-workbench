import type { SessionDetail } from "../types";
import { RunDetail } from "../components/RunDetail";
import { useWorkbenchCopy } from "./copy";

export function RunsWorkspace({
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
  const copy = useWorkbenchCopy();
  if (selectedRunId) {
    return <RunDetail runId={selectedRunId} onBack={onCloseRun} />;
  }

  const runs = detail?.runs ?? [];
  return (
    <article className="workbench-document" data-testid="runs-workspace">
      <header className="workbench-document-heading">
        <p className="workbench-eyebrow">{copy.run.eyebrow}</p>
        <h1>{copy.run.title}</h1>
        <p>{copy.run.description}</p>
      </header>
      {runs.length === 0 ? (
        <p className="workbench-empty-line">{copy.run.empty}</p>
      ) : (
        <div className="workbench-run-list">
          {runs.map((run) => (
            <button
              key={run.run_id}
              type="button"
              className="workbench-run-row"
              onClick={() => onOpenRun(run.run_id)}
            >
              <span className="workbench-run-status" data-status={run.status} aria-hidden />
              <span className="workbench-run-main">
                <strong>{run.title || run.run_type}</strong>
                <small>{run.run_type}{run.origin ? ` · ${run.origin}` : ""}</small>
              </span>
              <span className="workbench-run-state">{run.status}</span>
              <span aria-hidden className="workbench-run-arrow">→</span>
            </button>
          ))}
        </div>
      )}
    </article>
  );
}
