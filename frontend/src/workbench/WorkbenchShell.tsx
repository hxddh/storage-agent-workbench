import { useEffect, useState, type ReactNode } from "react";
import type { SessionSummaryRow } from "../types";
import { useSessionRun } from "../sessionRuns";
import { publishWorkbenchCommands } from "./commands";
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
  timeline,
  sessionId,
  session,
  sidecarStatus,
  onOpenPalette,
  onOpenSettings,
}: {
  navigation: ReactNode;
  timeline: ReactNode;
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

  useEffect(() => publishWorkbenchCommands((command) => {
    if (command.type === "run.open") {
      setSelectedRunId(command.runId);
      setReview("runs");
      return;
    }
    if (command.surface === "timeline") {
      setReview(null);
      setSelectedRunId(null);
      return;
    }
    setReview(command.surface);
  }), []);

  const title = session?.title?.trim() || copy.task.newTask;
  const scope = session?.primary_bucket?.trim() || session?.goal?.trim() || copy.task.noScope;
  const outputCount = (session?.finding_count ?? 0) + (session?.run_count ?? 0);
  const state = run.uploading
    ? { label: copy.states.uploading, tone: "uploading" }
    : run.busy
      ? { label: copy.states.working, tone: "working" }
      : run.error || run.needKey
        ? { label: copy.states.attention, tone: "attention" }
        : sessionId
          ? { label: copy.states.ready, tone: "ready" }
          : { label: copy.states.delegate, tone: "idle" };

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
            <button type="button" className="agent-native-icon" onClick={onOpenSettings} aria-label={copy.settings} title={copy.settings}>⚙</button>
            <button type="button" className="agent-native-icon" onClick={() => setFocus((value) => !value)} aria-label={focus ? copy.exitFocus : copy.focus} title={focus ? copy.exitFocus : copy.focus}>{focus ? "↙" : "↗"}</button>
          </div>
        </header>

        <div className="agent-task-workspace">
          <section className="agent-task-thread" aria-label={copy.task.workspace}>{timeline}</section>
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
