import { useEffect, useRef, type ReactNode } from "react";
import type { TaskExecution } from "../api";
import { useI18n } from "../i18n";
import { timeAgo } from "../lib/time";
import { useAgentCopy } from "../agent/agentCopy";
import { EvidenceReview } from "../agent/EvidenceReview";
import { ReportArtifact } from "../agent/ReportArtifact";
import type { ArtifactKind } from "../agent/model";
import { useTaskDetails } from "../agent/taskDetails";
import { ExecutionDetail } from "./ExecutionDetail";
import { Icon } from "./icons";
import { revealInScroller } from "../lib/scroll";

/** The first line of the Direction, bounded, as an execution's name. */
function executionTitle(execution: TaskExecution): string {
  const line = (execution.direction ?? "").split("\n").map((part) => part.trim()).find(Boolean) ?? "";
  return line.length > 96 ? `${line.slice(0, 95)}…` : line;
}

function DetailRow({
  kind,
  label,
  meta,
  open,
  onToggle,
  children,
}: {
  kind: ArtifactKind;
  label: string;
  meta?: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Opened from elsewhere (a tool row, a provenance mark, ⌘I): bring it into view.
  useEffect(() => {
    if (open) revealInScroller(ref.current, "nearest");
  }, [open]);
  return (
    <div ref={ref} className="task-detail" data-testid={`task-detail-${kind}`} data-open={open ? "true" : "false"}>
      <button type="button" className="task-detail-head" aria-expanded={open} onClick={onToggle} data-testid={`task-detail-toggle-${kind}`}>
        <span className="task-detail-chevron" aria-hidden><Icon name="chevron" size={12} /></span>
        <span className="task-detail-label">{label}</span>
        {meta ? <span className="task-detail-meta">{meta}</span> : null}
      </button>
      {open ? <div className="task-detail-body">{children}</div> : null}
    </div>
  );
}

/**
 * v2.0 — the Task's durable outputs as rows under the Result, each expanding
 * in place: Evidence, Report and Execution detail. A row appears only when
 * there is something behind it; there are no empty placeholders.
 */
export function TaskDetails({ hasResult }: { hasResult: boolean }) {
  const copy = useAgentCopy();
  const { t } = useI18n();
  const c = copy.artifacts;
  const { taskId, selection, projection, provenance, open, back, close } = useTaskDetails();
  const { detail, executions, report, reportLoading, error } = projection;
  if (!taskId) return null;

  const findings = detail?.findings ?? [];
  const files = detail?.attached_files ?? [];
  const available: ArtifactKind[] = [];
  if (findings.length > 0 || files.length > 0) available.push("evidence");
  if (hasResult) available.push("report");
  if (executions.length > 0) available.push("execution");
  // ⌘I or a command may name a row this task does not have: open the first
  // one it does, instead of expanding nothing.
  const openKind: ArtifactKind | null = selection
    ? available.includes(selection.kind) ? selection.kind : available[0] ?? null
    : null;
  const toggle = (kind: ArtifactKind) => () => (openKind === kind ? close() : open(kind));
  const isOpen = (kind: ArtifactKind) => openKind === kind;
  const when = (iso?: string | null) => (iso ? <span title={iso}>{timeAgo(iso, t) || iso.slice(0, 16)}</span> : null);

  const rows: ReactNode[] = [];
  if (findings.length > 0 || files.length > 0) {
    rows.push(
      <DetailRow key="evidence" kind="evidence" label={c.sections.evidence} meta={copy.details.findings(findings.length)} open={isOpen("evidence")} onToggle={toggle("evidence")}>
        <EvidenceReview detail={detail} taskId={taskId} selectedFindingId={selection?.kind === "evidence" ? selection.findingId ?? selection.id : null} provenance={provenance} />
      </DetailRow>,
    );
  }
  if (hasResult) {
    rows.push(
      <DetailRow key="report" kind="report" label={c.report} open={isOpen("report")} onToggle={toggle("report")}>
        <ReportArtifact report={report} loading={reportLoading} error={error} />
      </DetailRow>,
    );
  }
  if (executions.length > 0) {
    const openExecution = selection?.kind === "execution" ? selection.id : null;
    rows.push(
      <DetailRow key="execution" kind="execution" label={c.sections.execution} meta={copy.details.executions(executions.length)} open={isOpen("execution")} onToggle={toggle("execution")}>
        {openExecution ? (
          <div className="task-detail-document">
            <button type="button" className="native-ghost-action" onClick={back} data-testid="task-detail-back">
              <span className="task-detail-back-icon" aria-hidden><Icon name="chevron" size={12} /></span>
              {c.sections.execution}
            </button>
            <ExecutionDetail taskId={taskId} executionId={openExecution} onBack={back} />
          </div>
        ) : (
          <div className="agent-run-list" data-testid="execution-review">
            {executions.map((execution) => (
              <button
                key={execution.id}
                type="button"
                className="agent-run-row"
                data-testid="execution-row"
                data-execution-id={execution.id}
                data-status={execution.status}
                onClick={() => open("execution", execution.id)}
              >
                <span className="agent-run-status" data-status={execution.status} aria-hidden />
                <span className="agent-run-main">
                  <strong>{executionTitle(execution) || c.execution.kinds[execution.kind] || execution.kind}</strong>
                  <small>{[c.execution.statuses[execution.status] ?? execution.status, execution.kind !== "direction" ? c.execution.kinds[execution.kind] ?? null : null].filter(Boolean).join(" · ")} · {when(execution.created_at)}</small>
                </span>
              </button>
            ))}
          </div>
        )}
      </DetailRow>,
    );
  }
  if (rows.length === 0) return null;
  return (
    <section className="task-details" data-testid="task-details" aria-label={copy.details.title}>
      {rows}
    </section>
  );
}
