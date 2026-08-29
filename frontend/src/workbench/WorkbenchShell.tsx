import { useEffect, useState, type ReactNode } from "react";
import type { SessionSummaryRow } from "../types";
import { useSessionRun } from "../sessionRuns";
import { publishAgentCommands } from "./commands";
import { AgentReviewPanel } from "./AgentReviewPanel";
import { useWorkbenchCopy } from "./copy";
import type { ReviewSurface } from "./model";
import { useWorkbenchProjection } from "./useWorkbenchProjection";

function ConnectionMark({ status }: { status: string }) {
  return (
    <span className="agent-native-connection" data-status={status} title={`Sidecar: ${status}`}>
      <span aria-hidden />
      {status}
    </span>
  );
}

export function WorkbenchShell({
  navigation,
  taskContent,
  sessionId,
  session,
  sidecarStatus,
  onOpenPalette,
  onOpenSettings,
}: {
  navigation: ReactNode;
  taskContent: ReactNode;
  sessionId: string | null;
  session: SessionSummaryRow | null;
  sidecarStatus: string;
  onOpenPalette: () => void;
  onOpenSettings: () => void;
}) {
  const copy = useWorkbenchCopy();
  const run = useSessionRun(sessionId);
  const [review, setReview] = useState<ReviewSurface | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [focus, setFocus] = useState(false);
  const { detail, report, reportLoading, error } = useWorkbenchProjection(sessionId, review);

  useEffect(() => {
    if (!sessionId) {
      setReview(null);
      setSelectedRunId(null);
    }
  }, [sessionId]);

  useEffect(() => publishAgentCommands((command) => {
    if (command.type === "execution.open") {
      setSelectedRunId(command.runId);
      setReview("runs");
      return;
    }
    if (command.type === "review.close") {
      setReview(null);
      setSelectedRunId(null);
      return;
    }
    setSelectedRunId(null);
    setReview(command.review);
  }), []);

  const title = session?.title?.trim() || copy.task.newTask;
  const scope = session?.primary_bucket?.trim() || session?.goal?.trim() || copy.task.noScope;
  const outputCount = (session?.finding_count ?? 0) + (session?.run_count ?? 0);
  const latestTool = run.streamTools.length ? run.streamTools[run.streamTools.length - 1] : null;
  const state = run.uploading
    ? { label: copy.states.uploading, tone: "uploading" }
    : run.busy
      ? { label: copy.states.working, tone: "working" }
      : run.error || run.needKey
        ? { label: copy.states.attention, tone: "attention" }
        : sessionId
          ? { label: copy.states.ready, tone: "ready" }
          : { label: copy.states.delegate, tone: "idle" };
  const liveExecution = latestTool
    ? `${latestTool.tool}${latestTool.target ? ` · ${latestTool.target}` : ""}`
    : copy.task.startingExecution;

  return (
    <div data-testid="workbench-shell" data-review={review ?? "closed"} data-focus={focus ? "true" : "false"} className="agent-native-shell">
      <aside className="agent-native-navigation" aria-label={copy.task.navigation}>{navigation}</aside>

      <section className="agent-native-main">
        <header className="agent-task-header" data-testid="workbench-commandbar">
          <div className="agent-task-identity">
            <div className="agent-task-breadcrumb">
              <span>Storage Agent</span>
              <span aria-hidden>/</span>
              <strong title={title}>{title}</strong>
            </div>
            <div className="agent-task-meta">
              <span className="agent-task-live-state" data-state={state.tone}>
                <i aria-hidden />{state.label}
              </span>
              <span aria-hidden>·</span>
              <span className="truncate" title={scope}>{scope}</span>
            </div>
          </div>

          <div className="agent-task-controls">
            {sessionId ? (
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
          <section className="agent-task-content" data-empty={sessionId ? "false" : "true"} aria-label={copy.task.workspace}>
            {!sessionId ? (
              <div className="agent-task-start-heading" aria-hidden="true">
                <span>{copy.task.readyEyebrow}</span>
                <h1>{copy.task.startTitle}</h1>
                <p>{copy.task.startDescription}</p>
              </div>
            ) : null}
            {taskContent}
          </section>
          {review && sessionId ? (
            <AgentReviewPanel
              view={review}
              detail={detail}
              report={report}
              reportLoading={reportLoading}
              error={error}
              selectedRunId={selectedRunId}
              onView={(next) => { setSelectedRunId(null); setReview(next); }}
              onOpenRun={(runId) => { setSelectedRunId(runId); setReview("runs"); }}
              onCloseRun={() => setSelectedRunId(null)}
              onClose={() => { setReview(null); setSelectedRunId(null); }}
            />
          ) : null}
        </div>
      </section>
    </div>
  );
}
