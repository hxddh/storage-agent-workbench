import { useEffect, useMemo, useReducer, type ReactNode } from "react";
import type { SessionSummaryRow } from "../types";
import { EvidenceWorkspace } from "./EvidenceWorkspace";
import { ReportWorkspace } from "./ReportWorkspace";
import { RunsWorkspace } from "./RunsWorkspace";
import { SteeringSurface } from "./SteeringSurface";
import { SurfaceTabs } from "./SurfaceTabs";
import { useWorkbenchCopy } from "./copy";
import { initialWorkbenchState, workbenchReducer } from "./model";
import { useWorkbenchProjection } from "./useWorkbenchProjection";

function ConnectionMark({ status }: { status: string }) {
  return (
    <span className="workbench-connection" data-status={status} title={`Sidecar: ${status}`}>
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
  const [state, dispatch] = useReducer(workbenchReducer, sessionId, initialWorkbenchState);
  const { detail, report, reportLoading, error: surfaceError } = useWorkbenchProjection(sessionId, state.surface);

  useEffect(() => {
    dispatch({ type: "session.changed", sessionId });
  }, [sessionId]);

  const title = session?.title || copy.newInvestigation;
  const goal = session?.goal?.trim() || null;
  const runCount = session?.run_count ?? 0;
  const findingCount = session?.finding_count ?? 0;
  const sessionReady = Boolean(sessionId);

  const surfaceTitle = useMemo(() => {
    switch (state.surface) {
      case "evidence": return copy.findings(findingCount);
      case "runs": return copy.runs(runCount);
      case "report": return copy.durableOutput;
      default: return goal || copy.agentTimeline;
    }
  }, [state.surface, findingCount, runCount, goal, copy]);

  const focusLabel = state.mode === "focus" ? copy.exitFocus : copy.focus;

  return (
    <div
      data-testid="workbench-shell"
      data-surface={state.surface}
      data-mode={state.mode}
      className="agent-os-shell"
    >
      <aside className="agent-os-navigation" aria-label="Investigations">
        {navigation}
      </aside>

      <section className="agent-os-main">
        <header className="agent-os-commandbar" data-testid="workbench-commandbar">
          <div className="agent-os-context">
            <div className="agent-os-title-row">
              <span className="agent-os-product">Storage Agent</span>
              <span className="agent-os-slash" aria-hidden>/</span>
              <strong title={title}>{title}</strong>
            </div>
            <span className="agent-os-context-detail" title={surfaceTitle}>{surfaceTitle}</span>
          </div>

          <SurfaceTabs
            active={state.surface}
            sessionReady={sessionReady}
            onChange={(surface) => dispatch({ type: "surface.open", surface })}
          />

          <div className="agent-os-actions">
            <ConnectionMark status={sidecarStatus} />
            <button type="button" className="agent-os-command" onClick={onOpenPalette} title={copy.commandPalette}>
              <span>{copy.command}</span><kbd>⌘K</kbd>
            </button>
            <button type="button" className="agent-os-icon-command" onClick={onOpenSettings} aria-label={copy.settings} title={copy.settings}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21h-4v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H3v-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3h4a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9A1.7 1.7 0 0 0 21 10h.1v4H21a1.7 1.7 0 0 0-1.6 1Z" />
              </svg>
            </button>
            <button
              type="button"
              className="agent-os-icon-command"
              onClick={() => dispatch({ type: state.mode === "focus" ? "surface.restore" : "surface.focus" })}
              aria-label={focusLabel}
              title={focusLabel}
            >
              {state.mode === "focus" ? "↙" : "↗"}
            </button>
          </div>
        </header>

        <div className="agent-os-stage">
          <section
            id="work-surface-timeline"
            role="tabpanel"
            aria-label={copy.surfaces.timeline.label}
            className="agent-os-surface agent-os-timeline"
            hidden={state.surface !== "timeline"}
          >
            {timeline}
          </section>

          {state.surface === "evidence" && (
            <section id="work-surface-evidence" role="tabpanel" aria-label={copy.surfaces.evidence.label} className="agent-os-surface agent-os-scroll-surface agent-os-steerable-surface">
              {surfaceError ? (
                <p className="workbench-surface-error">{surfaceError}</p>
              ) : sessionId ? (
                <EvidenceWorkspace detail={detail} sessionId={sessionId} />
              ) : (
                <p className="workbench-empty-line">{copy.selectEvidence}</p>
              )}
            </section>
          )}

          {state.surface === "runs" && (
            <section id="work-surface-runs" role="tabpanel" aria-label={copy.surfaces.runs.label} className="agent-os-surface agent-os-scroll-surface agent-os-steerable-surface">
              {surfaceError ? (
                <p className="workbench-surface-error">{surfaceError}</p>
              ) : (
                <RunsWorkspace
                  detail={detail}
                  selectedRunId={state.selectedRunId}
                  onOpenRun={(runId) => dispatch({ type: "run.open", runId })}
                  onCloseRun={() => dispatch({ type: "run.close" })}
                />
              )}
            </section>
          )}

          {state.surface === "report" && (
            <section id="work-surface-report" role="tabpanel" aria-label={copy.surfaces.report.label} className="agent-os-surface agent-os-scroll-surface agent-os-steerable-surface">
              <ReportWorkspace report={report} loading={reportLoading} error={surfaceError} />
            </section>
          )}

          <SteeringSurface
            sessionId={sessionId}
            visible={state.surface !== "timeline"}
            offline={sidecarStatus !== "connected"}
          />
        </div>
      </section>
    </div>
  );
}
