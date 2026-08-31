import { useEffect, useState, type ReactNode } from "react";
import { useSessionRun } from "../sessionRuns";
import { publishAgentCommands } from "./commands";
import { AgentReviewPanel } from "./AgentReviewPanel";
import { useAgentCopy } from "./agentCopy";
import type { ReviewSurface } from "./model";
import type { AgentTaskSummary } from "./navigationModel";
import { agentTaskState } from "./taskState";
import { useAgentTaskProjection } from "./useAgentTaskProjection";
import { useTaskProvenance } from "../hooks/useTaskProvenance";

export function AgentShell({
  navigation,
  taskContent,
  taskId,
  task,
}: {
  navigation: ReactNode;
  taskContent: ReactNode;
  taskId: string | null;
  task: AgentTaskSummary | null;
  sidecarStatus: string;
  onOpenPalette: () => void;
  onOpenSettings: () => void;
}) {
  const copy = useAgentCopy();
  const run = useSessionRun(taskId);
  const [review, setReview] = useState<ReviewSurface | null>(null);
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(null);
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
  const [focus, setFocus] = useState(false);
  const { detail, report, reportLoading, error } = useAgentTaskProjection(taskId, review);
  const provenance = useTaskProvenance(taskId, Boolean(review) || Boolean(taskId));

  useEffect(() => {
    if (!taskId) {
      setReview(null);
      setSelectedExecutionId(null);
      setSelectedFindingId(null);
    }
  }, [taskId]);

  useEffect(() => publishAgentCommands((command) => {
    if (command.type === "execution.open") {
      setSelectedExecutionId(command.executionId);
      setSelectedFindingId(null);
      setReview("execution");
      return;
    }
    if (command.type === "review.close") {
      setReview(null);
      setSelectedExecutionId(null);
      setSelectedFindingId(null);
      return;
    }
    setSelectedExecutionId(null);
    setSelectedFindingId(command.findingId ?? null);
    setReview(command.review);
  }), []);

  const title = task?.title?.trim() || copy.task.newTask;
  const latestTool = run.streamTools.length ? run.streamTools[run.streamTools.length - 1] : null;
  const stateKey = agentTaskState(run, Boolean(taskId), task?.requires_decision ?? false,
    task?.task_status);
  const liveExecution = latestTool
    ? `${latestTool.tool}${latestTool.target ? ` · ${latestTool.target}` : ""}`
    : copy.task.startingExecution;

  return (
    <div data-testid="agent-shell" data-review={review ?? "closed"} data-focus={focus ? "true" : "false"} className="agent-native-shell">
      <aside className="agent-native-navigation" aria-label={copy.task.navigation}>{navigation}</aside>

      <section className="agent-native-main">
        <header className="agent-task-header" data-testid="agent-task-header" data-state={stateKey}>
          <div className="agent-task-identity">
            <h1 className="agent-task-title" title={title}>{title}</h1>
          </div>

          <div className="agent-task-controls">
            <button type="button" className="agent-native-icon" onClick={() => setFocus((value) => !value)} aria-label={focus ? copy.exitFocus : copy.focus} title={focus ? copy.exitFocus : copy.focus}>
              {focus ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" /><line x1="10" y1="14" x2="3" y2="21" /><line x1="14" y1="10" x2="21" y2="3" /></svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></svg>
              )}
            </button>
          </div>
        </header>

        {run.busy || run.uploading ? (
          <div className="agent-execution-strip" data-testid="agent-live-status">
            <span className="agent-execution-pulse" aria-hidden />
            <strong>{run.uploading ? copy.states.uploading : copy.states.working}</strong>
            <span className="agent-execution-current" title={liveExecution}>{liveExecution}</span>
            {run.streamTools.length ? <span className="agent-execution-count">{copy.task.toolsRun(run.streamTools.length)}</span> : null}
            <span className="agent-execution-steer-hint">{copy.task.steerHint}</span>
          </div>
        ) : null}

        <div className="agent-task-workspace">
          <section className="agent-task-content" data-empty={taskId ? "false" : "true"} aria-label={copy.task.workspace}>
            {taskContent}
          </section>
          {review && taskId ? (
            <AgentReviewPanel
              view={review}
              detail={detail}
              report={report}
              reportLoading={reportLoading}
              error={error}
              selectedExecutionId={selectedExecutionId}
              selectedFindingId={selectedFindingId}
              provenance={provenance}
              onOpenExecution={(executionId) => { setSelectedExecutionId(executionId); setSelectedFindingId(null); setReview("execution"); }}
              onCloseExecution={() => setSelectedExecutionId(null)}
              onClose={() => { setReview(null); setSelectedExecutionId(null); setSelectedFindingId(null); }}
            />
          ) : null}
        </div>
      </section>
    </div>
  );
}
