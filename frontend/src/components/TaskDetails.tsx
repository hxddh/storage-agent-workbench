import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { TaskExecution } from "../api";
import { useI18n } from "../i18n";
import { timeAgo } from "../lib/time";
import { useAgentCopy } from "../agent/agentCopy";
import { EvidenceReview } from "../agent/EvidenceReview";
import { ReportArtifact } from "../agent/ReportArtifact";
import type { ArtifactKind } from "../agent/model";
import { useTaskDetails, type TaskDetailsState } from "../agent/taskDetails";
import { useNavigationCopy } from "../agent/navigationCopy";
import { ExecutionDetail } from "./ExecutionDetail";
import { Icon, type IconName } from "./icons";
import { IconButton } from "./ui";
import { unifyFindings } from "../lib/findings";

/** The first line of the Direction, bounded, as an execution's name. */
function executionTitle(execution: TaskExecution): string {
  const line = (execution.direction ?? "").split("\n").map((part) => part.trim()).find(Boolean) ?? "";
  return line.length > 96 ? `${line.slice(0, 95)}…` : line;
}

const KIND_ICON: Record<ArtifactKind, IconName> = { evidence: "evidence", report: "report", execution: "activity" };

/** Which outputs this task actually has — a tab or a button exists only when
 * something is behind it (no empty placeholders). */
/** v3.1 — the one findings list, read by the Result AND the Evidence tab:
 * the recorded conclusion joined by the task's complete recorded findings
 * (the provenance projection is capped, so it only supplies chains, joined
 * by id — it is the recorded set only until the task record has loaded). */
export function taskFindings(details: TaskDetailsState) {
  return unifyFindings(
    details.conclusion,
    details.projection.detail?.findings ?? details.provenance?.findings,
    details.provenance?.findings,
  );
}

export function availableKinds(details: TaskDetailsState, hasResult: boolean): ArtifactKind[] {
  const { detail, executions } = details.projection;
  const kinds: ArtifactKind[] = [];
  if (taskFindings(details).length > 0 || (detail?.attached_files?.length ?? 0) > 0) kinds.push("evidence");
  if (hasResult) kinds.push("report");
  if (executions.length > 0) kinds.push("execution");
  return kinds;
}

function shownKind(selected: ArtifactKind | null, kinds: ArtifactKind[]): ArtifactKind | null {
  if (!selected) return null;
  return kinds.includes(selected) ? selected : kinds[0] ?? null;
}

function useKindLabels() {
  const copy = useAgentCopy();
  return {
    evidence: copy.artifacts.sections.evidence,
    report: copy.artifacts.report,
    execution: copy.artifacts.sections.execution,
  } satisfies Record<ArtifactKind, string>;
}

function kindCount(details: TaskDetailsState, kind: ArtifactKind): number | null {
  const { detail, executions } = details.projection;
  if (kind === "evidence") return taskFindings(details).length + (detail?.attached_files?.length ?? 0) || null;
  if (kind === "execution") return executions.length || null;
  return null;
}

/**
 * v3.0 — the Task's durable outputs as one quiet bar under the Result:
 * Evidence · Report · Execution. Each opens the inspector on the right; the
 * document itself stays one reading column. A button exists only when
 * something is behind it.
 */
export function TaskDetails({ hasResult }: { hasResult: boolean }) {
  const details = useTaskDetails();
  const labels = useKindLabels();
  const { taskId, selection, open, close } = details;
  if (!taskId) return null;
  const kinds = availableKinds(details, hasResult);
  if (kinds.length === 0) return null;
  // The kind the side pane actually shows (a selection without anything
  // behind it falls back to the first output, as the pane does).
  const shown = shownKind(selection?.kind ?? null, kinds);
  return (
    <nav className="task-outputs" data-testid="task-details" aria-label={labels.execution}>
      {kinds.map((kind) => {
        const count = kindCount(details, kind);
        const active = shown === kind;
        return (
          <button
            key={kind}
            type="button"
            className="task-output"
            aria-pressed={active}
            data-testid={`task-detail-toggle-${kind}`}
            onClick={() => (active ? close() : open(kind))}
          >
            <Icon name={KIND_ICON[kind]} size={14} />
            <span>{labels[kind]}</span>
            {count != null ? <small>{count}</small> : null}
            <Icon name="chevron" size={14} className="task-output-chevron" />
          </button>
        );
      })}
    </nav>
  );
}

const PANE_WIDTH_KEY = "saw.sidepaneWidth";
const PANE_MIN = 352;
const PANE_MAX = 880;

function storedInspectorWidth(): number | null {
  try {
    const raw = Number(localStorage.getItem(PANE_WIDTH_KEY));
    return Number.isFinite(raw) && raw >= PANE_MIN ? Math.min(raw, PANE_MAX) : null;
  } catch { return null; }
}

/**
 * v3.0 — the inspector: the open output as a document on the right,
 * resizable (drag the left edge, double-click to reset) and closable
 * (the close button, Esc, ⌘I). Tabs switch between the outputs the task has.
 */
export function TaskInspector({ hasResult }: { hasResult: boolean }) {
  const details = useTaskDetails();
  const copy = useAgentCopy();
  const nav = useNavigationCopy();
  const { t } = useI18n();
  const labels = useKindLabels();
  const c = copy.artifacts;
  const { taskId, selection, projection, open, back, close } = details;
  const [width, setWidth] = useState<number | null>(storedInspectorWidth);
  const panelRef = useRef<HTMLElement | null>(null);
  const kinds = availableKinds(details, hasResult);
  const kind = shownKind(selection?.kind ?? null, kinds);

  // A selection with nothing behind it (⌘I asks for Evidence on a task that
  // has none) settles on the output the pane actually shows, so that output
  // is the one that loads.
  useEffect(() => {
    if (selection && kind && kind !== selection.kind) open(kind);
  }, [selection?.kind, kind]);

  // Focus lands in the panel when it opens, so the keyboard follows the eye.
  useEffect(() => {
    if (selection) panelRef.current?.focus({ preventScroll: true });
  }, [selection?.kind, selection?.id]);

  if (!taskId || !selection) return null;
  const { detail, executions, report, reportLoading, error } = projection;
  const openExecution = selection.kind === "execution" ? selection.id : null;
  const when = (iso?: string | null) => (iso ? <span title={iso}>{timeAgo(iso, t) || iso.slice(0, 16)}</span> : null);

  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    const right = panelRef.current?.getBoundingClientRect().right ?? window.innerWidth;
    handle.setPointerCapture(event.pointerId);
    const move = (next: globalThis.PointerEvent) => {
      const px = Math.max(PANE_MIN, Math.min(PANE_MAX, right - next.clientX));
      setWidth(px);
      try { localStorage.setItem(PANE_WIDTH_KEY, String(px)); } catch {}
    };
    const stop = () => { handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", stop); handle.removeEventListener("pointercancel", stop); };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  };

  return (
    <aside
      ref={panelRef}
      tabIndex={-1}
      className="native-sidepane"
      data-testid="task-sidepane"
      data-kind={kind ?? "none"}
      aria-label={nav.inspector}
      style={width ? { width } : undefined}
    >
      <div
        className="native-sidepane-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label={nav.resize}
        onPointerDown={startResize}
        onDoubleClick={() => { setWidth(null); try { localStorage.removeItem(PANE_WIDTH_KEY); } catch {} }}
      />
      <header className="native-sidepane-head">
        <div className="native-sidepane-tabs" role="tablist" aria-label={nav.inspector}>
          {kinds.map((k) => {
            const count = kindCount(details, k);
            return (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={k === kind}
                className="native-sidepane-tab"
                data-testid={`sidepane-tab-${k}`}
                onClick={() => open(k)}
              >
                <Icon name={KIND_ICON[k]} size={14} />
                {labels[k]}
                {count != null ? <small>{count}</small> : null}
              </button>
            );
          })}
        </div>
        <IconButton icon="close" label={t("common.close")} onClick={close} data-testid="sidepane-close" />
      </header>
      <div className="native-sidepane-body" role="tabpanel">
        {kind === null ? (
          <p className="native-sidepane-empty">{c.execution.statuses.queued}</p>
        ) : kind === "evidence" ? (
          <div data-testid="task-detail-evidence" data-open="true">
            <EvidenceReview detail={detail} findings={taskFindings(details)} selectedFindingId={selection.findingId ?? selection.id} />
          </div>
        ) : kind === "report" ? (
          <div data-testid="task-detail-report" data-open="true">
            <ReportArtifact report={report} loading={reportLoading} error={error} />
          </div>
        ) : (
          <div data-testid="task-detail-execution" data-open="true">
            {openExecution ? (
              <div className="task-detail-document">
                <div className="px-3 pt-3">
                  <button type="button" className="native-ghost-action" onClick={back} data-testid="task-detail-back">
                    <span className="task-detail-back-icon" aria-hidden><Icon name="chevron" size={14} /></span>
                    {c.sections.execution}
                  </button>
                </div>
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
                    <Icon name="chevron" size={14} className="agent-run-chevron" />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
