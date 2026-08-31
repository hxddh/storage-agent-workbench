import { useEffect, useState } from "react";
import type { RemediationPlan, RemediationPlanStatus, RevisitSchedule, TaskArtifact, TaskBaseline, TaskDecision } from "../api";
import type { SessionDetail } from "../types";
import { EvidenceReview } from "./EvidenceReview";
import { ReportArtifact } from "./ReportArtifact";
import { ExecutionReview } from "./ExecutionReview";
import type { ReviewSurface } from "./model";
import { useAgentCopy } from "./agentCopy";
import { AnalysisFigures } from "../viz/AnalysisFigures";
import { ProvenanceMark } from "../viz/ProvenanceMark";
import type { TaskProvenance } from "../viz/types";

const PLAN_STATUSES: RemediationPlanStatus[] = ["proposed", "verified", "partially_verified", "stale"];

export function AgentReviewPanel({
  view,
  detail,
  artifacts = [],
  decisions = [],
  plans = [],
  baselines = [],
  revisit = null,
  onSaveRevisit,
  report,
  reportLoading,
  error,
  selectedExecutionId,
  selectedFindingId,
  provenance = null,
  onView,
  onOpenExecution,
  onCloseExecution,
  onClose,
}: {
  view: ReviewSurface;
  detail: SessionDetail | null;
  artifacts?: TaskArtifact[];
  decisions?: TaskDecision[];
  plans?: RemediationPlan[];
  baselines?: TaskBaseline[];
  revisit?: RevisitSchedule | null;
  onSaveRevisit?: (intervalDays: number, enabled: boolean) => Promise<void>;
  report: string | null;
  reportLoading: boolean;
  error: string | null;
  selectedExecutionId: string | null;
  selectedFindingId?: string | null;
  provenance?: TaskProvenance | null;
  onView: (view: ReviewSurface) => void;
  onOpenExecution: (executionId: string) => void;
  onCloseExecution: () => void;
  onClose: () => void;
}) {
  const copy = useAgentCopy();
  const findingCount = detail?.findings.length ?? 0;
  const executionCount = detail?.runs.filter((execution) => execution.origin !== "agent").length ?? 0;
  const latestPlan = plans[0] ?? null;
  const driftArtifacts = artifacts.filter((artifact) => artifact.artifact_type === "drift_report");
  const planStatus = (latestPlan && PLAN_STATUSES.includes(latestPlan.status)
    ? latestPlan.status
    : "proposed") as RemediationPlanStatus;

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
            {detail?.summary?.summary_md?.trim() || detail?.goal?.trim() ? (
              <section>
                <div className="agent-review-section-label">{copy.review.currentState}</div>
                <p className="agent-review-summary">
                  {detail?.summary?.summary_md?.trim() || detail?.goal?.trim()}
                </p>
              </section>
            ) : null}

            {provenance?.analysis.cost || provenance?.analysis.drift || provenance?.analysis.inventory ? (
              <section data-testid="review-overview-figures">
                <AnalysisFigures provenance={provenance} compact />
              </section>
            ) : null}

            {latestPlan ? (
              <section data-testid="remediation-plan-status">
                <div className="agent-review-section-label">{copy.review.plan}</div>
                <div className="agent-review-list">
                  <div data-plan-status={latestPlan.status}>
                    <span className="agent-review-list-dot" data-status={latestPlan.status} aria-hidden />
                    <span className="min-w-0">
                      <strong>{latestPlan.title || copy.review.plan}</strong>
                      <small>
                        {copy.review.planStatus[planStatus]}
                        {` · v${latestPlan.version}`}
                      </small>
                    </span>
                  </div>
                </div>
              </section>
            ) : null}

            {baselines.length ? (
              <section data-testid="task-baselines">
                <div className="agent-review-section-label">{copy.review.baseline}</div>
                <div className="agent-review-list">
                  {baselines.slice(0, 5).map((baseline) => (
                    <div key={baseline.id}>
                      <span className="agent-review-list-dot" data-artifact="baseline" aria-hidden />
                      <span className="min-w-0">
                        <strong>{`v${baseline.version}`}</strong>
                        <small>{baseline.created_at}</small>
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {driftArtifacts.length ? (
              <section data-testid="task-drift">
                <div className="agent-review-section-label">{copy.review.drift}</div>
                <div className="agent-review-list">
                  {driftArtifacts.slice(0, 4).map((artifact) => (
                    <button type="button" key={artifact.id} onClick={() => onView("report")}>
                      <span className="agent-review-list-dot" data-artifact="drift_report" aria-hidden />
                      <span className="min-w-0">
                        <strong>{artifact.title || copy.review.drift}</strong>
                        {artifact.summary ? <small>{artifact.summary}</small> : null}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}

            {revisit && (revisit.enabled === 1 || revisit.enabled === true || revisit.last_catchup_note) ? (
              <RevisitSection
                schedule={revisit}
                onSave={onSaveRevisit}
                copy={copy}
              />
            ) : null}

            {provenance?.findings.length || detail?.findings.length ? (
              <section>
                <div className="agent-review-section-label">{copy.review.latestFindings}</div>
                <div className="agent-review-list">
                  {(provenance?.findings ?? detail?.findings ?? []).slice(0, 5).map((finding) => (
                    "chain" in finding ? (
                      <ProvenanceMark key={finding.id} finding={finding} />
                    ) : (
                      <button type="button" key={finding.id} onClick={() => onView("evidence")}>
                        <span className="agent-review-list-dot" data-severity={finding.severity ?? "info"} aria-hidden />
                        <span className="min-w-0">
                          <strong>{finding.title || copy.review.untitledFinding}</strong>
                          {finding.interpretation ? <small>{finding.interpretation}</small> : null}
                        </span>
                      </button>
                    )
                  ))}
                </div>
              </section>
            ) : null}

            {detail?.runs.some((execution) => execution.origin !== "agent") ? (
              <section>
                <div className="agent-review-section-label">{copy.review.execution}</div>
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
              </section>
            ) : null}

            {artifacts.length ? (
              <section>
                <div className="agent-review-section-label">{copy.review.artifacts}</div>
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
                        {artifact.status ? <small> · {artifact.status}</small> : null}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}

            {decisions.length ? (
              <section>
                <div className="agent-review-section-label">{copy.review.decisionHistory}</div>
                <div className="agent-review-list" data-testid="decision-history">
                  {decisions.map((decision) => (
                    <div key={decision.id} data-decision-status={decision.status}>
                      <span className="agent-review-list-dot" data-status={decision.status} aria-hidden />
                      <span className="min-w-0">
                        <strong>{decision.title || decision.action_type}</strong>
                        <small>
                          {copy.review.decisionStatus[decision.status]}
                          {decision.impact?.scan_scope ? ` · ${decision.impact.scan_scope}` : ""}
                          {decision.reason ? ` · ${decision.reason}` : ""}
                        </small>
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        ) : null}

        {!error && view === "evidence" ? (
          detail ? <EvidenceReview detail={detail} sessionId={detail.id} selectedFindingId={selectedFindingId ?? null} provenance={provenance} /> : <p className="agent-review-empty">{copy.review.loading}</p>
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

function RevisitSection({
  schedule,
  onSave,
  copy,
}: {
  schedule: RevisitSchedule | null;
  onSave?: (intervalDays: number, enabled: boolean) => Promise<void>;
  copy: ReturnType<typeof useAgentCopy>;
}) {
  const enabled = Boolean(schedule && (schedule.enabled === 1 || schedule.enabled === true));
  const [days, setDays] = useState(String(schedule?.interval_days || 7));
  useEffect(() => {
    if (schedule?.interval_days) setDays(String(schedule.interval_days));
  }, [schedule?.interval_days]);
  const interval = Math.max(1, Math.min(365, Number.parseInt(days, 10) || 7));
  return (
    <section data-testid="task-revisit">
      <div className="agent-review-section-label">{copy.review.revisit}</div>
      <p className="agent-review-empty">
        {enabled ? copy.review.revisitOn(schedule?.interval_days || interval) : copy.review.revisitOff}
        {schedule?.last_catchup_note ? ` · ${copy.review.revisitCatchup}` : ""}
      </p>
      {onSave ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            type="number"
            min={1}
            max={365}
            value={days}
            onChange={(event) => setDays(event.target.value)}
            className="w-16 rounded-md border border-edge bg-elevated px-2 py-1 text-xs text-gray-100"
            aria-label={copy.review.revisit}
          />
          <button
            type="button"
            className="rounded-md border border-edge px-2 py-1 text-xs text-gray-200 hover:bg-hover"
            onClick={() => void onSave(interval, true)}
          >
            {copy.review.revisitSave}
          </button>
          <button
            type="button"
            data-testid="task-revisit-toggle"
            className="rounded-md border border-edge px-2 py-1 text-xs text-gray-200 hover:bg-hover"
            onClick={() => void onSave(interval, !enabled)}
          >
            {enabled ? copy.review.revisitDisable : copy.review.revisitEnable}
          </button>
        </div>
      ) : null}
    </section>
  );
}
