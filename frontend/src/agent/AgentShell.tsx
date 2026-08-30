import { useEffect, useState, type ReactNode } from "react";
import { useSessionRun } from "../sessionRuns";
import { publishAgentCommands } from "./commands";
import { AgentReviewPanel } from "./AgentReviewPanel";
import { useAgentCopy } from "./agentCopy";
import type { ReviewSurface } from "./model";
import type { AgentTaskSummary } from "./navigationModel";
import { agentTaskState } from "./taskState";
import { useAgentTaskProjection } from "./useAgentTaskProjection";

function ConnectionMark({ status }: { status: string }) {
  return (
    <span className="agent-native-connection" data-status={status} title={`Sidecar: ${status}`}>
      <span aria-hidden />
      {status}
    </span>
  );
}

export function AgentShell({
  navigation,
  taskContent,
  taskId,
  task,
  sidecarStatus,
  onOpenPalette,
  onOpenSettings,
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
  const [focus, setFocus] = useState(false);
  const { detail, artifacts, decisions, plans, baselines, revisit, saveRevisit, report, reportLoading, error } = useAgentTaskProjection(taskId, review);

  useEffect(() => {
    if (!taskId) {
      setReview(null);
      setSelectedExecutionId(null);
    }
  }, [taskId]);

  useEffect(() => publishAgentCommands((command) => {
    if (command.type === "execution.open") {
      setSelectedExecutionId(command.executionId);
      setReview("execution");
      return;
    }
    if (command.type === "review.close") {
      setReview(null);
      setSelectedExecutionId(null);
      return;
    }
    setSelectedExecutionId(null);
    setReview(command.review);
  }), []);

  const title = task?.title?.trim() || copy.task.newTask;
  const scope = task?.primary_bucket?.trim() || task?.goal?.trim() || copy.task.noScope;
  const outputCount = (task?.finding_count ?? 0) + (task?.run_count ?? 0);
  const latestTool = run.streamTools.length ? run.streamTools[run.streamTools.length - 1] : null;
  const stateKey = agentTaskState(run, Boolean(taskId), task?.requires_decision ?? false,
    task?.task_status);
  const stateLabel = stateKey === "idle"
    ? copy.states.delegate
    : stateKey === "ready"
      ? copy.states.ready
      : stateKey === "working"
        ? copy.states.working
        : stateKey === "uploading"
          ? copy.states.uploading
          : stateKey === "decision"
            ? copy.states.decision
            : copy.states.attention;
  const liveExecution = latestTool
    ? `${latestTool.tool}${latestTool.target ? ` · ${latestTool.target}` : ""}`
    : copy.task.startingExecution;

  return (
    <div data-testid="agent-shell" data-review={review ?? "closed"} data-focus={focus ? "true" : "false"} className="agent-native-shell">
      <aside className="agent-native-navigation" aria-label={copy.task.navigation}>{navigation}</aside>

      <section className="agent-native-main">
        <header className="agent-task-header" data-testid="agent-task-header">
          <div className="agent-task-identity">
            <div className="agent-task-breadcrumb">
              <span>Storage Agent</span>
              <span aria-hidden>/</span>
              <strong title={title}>{title}</strong>
            </div>
            <div className="agent-task-meta">
              <span className="agent-task-live-state" data-state={stateKey}>
                <i aria-hidden />{stateLabel}
              </span>
              <span aria-hidden>·</span>
              <span className="truncate" title={scope}>{scope}</span>
            </div>
          </div>

          <div className="agent-task-controls">
            {taskId ? (
              <button type="button" className="agent-task-review-button" onClick={() => setReview((current) => current ? null : "overview")} aria-expanded={Boolean(review)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                  <path d="M4 5h16M4 12h16M4 19h10" />
                </svg>
                <span>{copy.review.open}</span>
                {outputCount > 0 ? <b>{outputCount}</b> : null}
              </button>
            ) : null}
            <ConnectionMark status={sidecarStatus} />
            <button type="button" className="agent-native-command" onClick={onOpenPalette} title={copy.commandPalette}><span>{copy.command}</span><kbd>⌘K</kbd></button>
            <button type="button" className="agent-native-icon" onClick={onOpenSettings} aria-label={copy.settings} title={copy.settings}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21h-4v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H3v-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3h4a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9A1.7 1.7 0 0 0 21 10h.1v4H21a1.7 1.7 0 0 0-1.6 1Z" />
              </svg>
            </button>
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
              artifacts={artifacts}
              decisions={decisions}
              plans={plans}
              baselines={baselines}
              revisit={revisit}
              onSaveRevisit={saveRevisit}
              view={review}
              detail={detail}
              report={report}
              reportLoading={reportLoading}
              error={error}
              selectedExecutionId={selectedExecutionId}
              onView={(next) => { setSelectedExecutionId(null); setReview(next); }}
              onOpenExecution={(executionId) => { setSelectedExecutionId(executionId); setReview("execution"); }}
              onCloseExecution={() => setSelectedExecutionId(null)}
              onClose={() => { setReview(null); setSelectedExecutionId(null); }}
            />
          ) : null}
        </div>
      </section>
    </div>
  );
}
