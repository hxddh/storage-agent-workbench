import { useEffect, useMemo, useReducer, useState, type ReactNode } from "react";
import { getSession, getSessionReport } from "../api";
import type { SessionDetail, SessionSummaryRow } from "../types";
import { Markdown } from "../components/Markdown";
import { RunDetail } from "../components/RunDetail";
import { EvidenceWorkspace } from "./EvidenceWorkspace";
import { SurfaceTabs } from "./SurfaceTabs";
import { initialWorkbenchState, workbenchReducer } from "./model";

function ConnectionMark({ status }: { status: string }) {
  return (
    <span className="workbench-connection" data-status={status} title={`Sidecar: ${status}`}>
      <span aria-hidden />
      {status}
    </span>
  );
}

function RunsWorkspace({
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
  if (selectedRunId) {
    return <RunDetail runId={selectedRunId} onBack={onCloseRun} />;
  }

  const runs = detail?.runs ?? [];
  return (
    <article className="workbench-document" data-testid="runs-workspace">
      <header className="workbench-document-heading">
        <p className="workbench-eyebrow">Runs</p>
        <h1>Auditable execution</h1>
        <p>Explicit runs stay separate from the conversation so execution can be inspected as evidence.</p>
      </header>
      {runs.length === 0 ? (
        <p className="workbench-empty-line">No explicit runs are attached to this investigation.</p>
      ) : (
        <div className="workbench-run-list">
          {runs.map((run) => (
            <button key={run.run_id} type="button" className="workbench-run-row" onClick={() => onOpenRun(run.run_id)}>
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

function ReportWorkspace({ report, loading, error }: { report: string | null; loading: boolean; error: string | null }) {
  return (
    <article className="workbench-document workbench-report" data-testid="report-workspace">
      <header className="workbench-document-heading">
        <p className="workbench-eyebrow">Report</p>
        <h1>Durable investigation output</h1>
        <p>The report is a first-class work surface rather than a modal layered over the conversation.</p>
      </header>
      {loading ? <p className="workbench-empty-line">Preparing report…</p> : null}
      {!loading && error ? <p className="workbench-empty-line">{error}</p> : null}
      {!loading && !error && report ? <div className="workbench-report-body"><Markdown text={report} /></div> : null}
      {!loading && !error && !report ? <p className="workbench-empty-line">No durable report has been generated yet.</p> : null}
    </article>
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
  const [state, dispatch] = useReducer(workbenchReducer, sessionId, initialWorkbenchState);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [surfaceError, setSurfaceError] = useState<string | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const [reportLoading, setReportLoading] = useState(false);

  useEffect(() => {
    dispatch({ type: "session.changed", sessionId });
    setDetail(null);
    setReport(null);
    setSurfaceError(null);
  }, [sessionId]);

  // Evidence and Runs are projections of the persisted investigation. Refresh
  // when either surface becomes active so a just-finished turn is reflected
  // without teaching the root shell about the Thread implementation's state.
  useEffect(() => {
    if (!sessionId || (state.surface !== "evidence" && state.surface !== "runs")) return;
    let cancelled = false;
    setSurfaceError(null);
    void getSession(sessionId)
      .then((next) => {
        if (!cancelled) setDetail(next);
      })
      .catch((error) => {
        if (!cancelled) setSurfaceError(String(error));
      });
    return () => { cancelled = true; };
  }, [sessionId, state.surface]);

  useEffect(() => {
    if (!sessionId || state.surface !== "report") return;
    let cancelled = false;
    setReportLoading(true);
    setSurfaceError(null);
    void getSessionReport(sessionId)
      .then((next) => {
        if (!cancelled) setReport(next.content);
      })
      .catch((error) => {
        if (!cancelled) {
          setReport(null);
          setSurfaceError(String(error));
        }
      })
      .finally(() => {
        if (!cancelled) setReportLoading(false);
      });
    return () => { cancelled = true; };
  }, [sessionId, state.surface]);

  const title = session?.title || "New investigation";
  const goal = session?.goal?.trim() || null;
  const runCount = session?.run_count ?? 0;
  const findingCount = session?.finding_count ?? 0;
  const sessionReady = Boolean(sessionId);

  const surfaceTitle = useMemo(() => {
    switch (state.surface) {
      case "evidence": return `${findingCount} finding${findingCount === 1 ? "" : "s"}`;
      case "runs": return `${runCount} run${runCount === 1 ? "" : "s"}`;
      case "report": return "durable output";
      default: return goal || "agent timeline";
    }
  }, [state.surface, findingCount, runCount, goal]);

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
            <button type="button" className="agent-os-command" onClick={onOpenPalette} title="Command palette">
              <span>Command</span><kbd>⌘K</kbd>
            </button>
            <button type="button" className="agent-os-icon-command" onClick={onOpenSettings} aria-label="Settings and providers" title="Settings and providers">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21h-4v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H3v-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3h4a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9A1.7 1.7 0 0 0 21 10h.1v4H21a1.7 1.7 0 0 0-1.6 1Z" />
              </svg>
            </button>
            <button
              type="button"
              className="agent-os-icon-command"
              onClick={() => dispatch({ type: state.mode === "focus" ? "surface.restore" : "surface.focus" })}
              aria-label={state.mode === "focus" ? "Exit focus mode" : "Focus work surface"}
              title={state.mode === "focus" ? "Exit focus mode" : "Focus work surface"}
            >
              {state.mode === "focus" ? "↙" : "↗"}
            </button>
          </div>
        </header>

        <div className="agent-os-stage">
          <section
            id="work-surface-timeline"
            role="tabpanel"
            aria-label="Timeline"
            className="agent-os-surface agent-os-timeline"
            hidden={state.surface !== "timeline"}
          >
            {timeline}
          </section>

          {state.surface === "evidence" && (
            <section id="work-surface-evidence" role="tabpanel" aria-label="Evidence" className="agent-os-surface agent-os-scroll-surface">
              {surfaceError ? (
                <p className="workbench-surface-error">{surfaceError}</p>
              ) : sessionId ? (
                <EvidenceWorkspace detail={detail} sessionId={sessionId} />
              ) : (
                <p className="workbench-empty-line">Select an investigation to review its evidence.</p>
              )}
            </section>
          )}

          {state.surface === "runs" && (
            <section id="work-surface-runs" role="tabpanel" aria-label="Runs" className="agent-os-surface agent-os-scroll-surface">
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
            <section id="work-surface-report" role="tabpanel" aria-label="Report" className="agent-os-surface agent-os-scroll-surface">
              <ReportWorkspace report={report} loading={reportLoading} error={surfaceError} />
            </section>
          )}
        </div>
      </section>
    </div>
  );
}
