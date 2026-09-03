import { useEffect, useRef, type ReactNode } from "react";
import type { RemediationPlan, TaskArtifact, TaskExecution } from "../api";
import type { TaskProvenance } from "../viz/types";
import { Markdown } from "../components/Markdown";
import { ExecutionDetail } from "../components/ExecutionDetail";
import { Icon } from "../components/icons";
import { useDismissOnEscape } from "../hooks/useDismissOnEscape";
import { useCopy } from "../hooks/useCopy";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useI18n } from "../i18n";
import { registerFindRoot } from "../lib/findRoots";
import { timeAgo } from "../lib/time";
import { useAgentCopy } from "./agentCopy";
import { EvidenceReview } from "./EvidenceReview";
import { ReportArtifact } from "./ReportArtifact";
import { ARTIFACT_KINDS, selectionOpensDocument, type ArtifactKind, type ArtifactSelection } from "./model";
import type { ArtifactsProjection } from "./useAgentTaskProjection";

const SECTION_ID: Record<ArtifactKind, "evidence" | "reports" | "plans" | "baselines" | "execution"> = {
  evidence: "evidence",
  report: "reports",
  plan: "plans",
  baseline: "baselines",
  execution: "execution",
};

function Section({
  kind,
  title,
  count,
  children,
}: {
  kind: ArtifactKind;
  title: string;
  count: number | null;
  children: ReactNode;
}) {
  const id = SECTION_ID[kind];
  return (
    <section className="agent-artifacts-section" data-testid={`artifacts-section-${id}`} id={`artifacts-${id}`}>
      <h2>
        <span>{title}</span>
        {count !== null && count > 0 ? <small>{count}</small> : null}
      </h2>
      {children}
    </section>
  );
}

function Row({
  title,
  meta,
  status,
  onOpen,
  testId,
}: {
  title: string;
  meta?: ReactNode;
  status?: string | null;
  onOpen: () => void;
  testId?: string;
}) {
  return (
    <button type="button" className="agent-artifact-row" onClick={onOpen} data-testid={testId} data-status={status ?? undefined}>
      <span className="agent-artifact-row-main">
        <strong>{title}</strong>
        {meta ? <small>{meta}</small> : null}
      </span>
      <Icon name="chevron" size={12} />
    </button>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="agent-empty-line">{children}</p>;
}

/** The first line of the Direction, bounded, as the row title. */
function executionTitle(execution: TaskExecution): string {
  const line = (execution.direction ?? "").split("\n").map((part) => part.trim()).find(Boolean) ?? "";
  return line.length > 96 ? `${line.slice(0, 95)}…` : line;
}

function stringOf(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number") return String(value);
  return null;
}

function listOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object") : [];
}

/** A Remediation Plan as a read-only document: actions, checklist, simulation coverage. */
function PlanDocument({ plan }: { plan: RemediationPlan }) {
  const copy = useAgentCopy();
  const c = copy.artifacts.plan;
  const body = plan.plan ?? {};
  const actions = listOf(body.actions);
  const checklist = listOf(body.checklist).concat(
    Array.isArray(body.checklist) ? (body.checklist as unknown[]).filter((item) => typeof item === "string").map((text) => ({ text })) : [],
  );
  const summary = stringOf(body.summary) ?? stringOf(body.rationale);
  const coverage = plan.simulation ? stringOf(plan.simulation.coverage) ?? stringOf((plan.simulation.coverage as Record<string, unknown> | undefined)?.note) : null;
  return (
    <article className="agent-artifact-document" data-testid="artifact-plan-document">
      <header>
        <strong>{plan.title || copy.artifacts.sections.plans}</strong>
        <small>{c.version(plan.version)} · {c.status[plan.status] ?? plan.status}</small>
      </header>
      {summary ? <Markdown text={summary} /> : null}
      <h3>{c.actions}</h3>
      {actions.length === 0 ? <Empty>{c.noActions}</Empty> : (
        <ol className="agent-plan-actions">
          {actions.map((action, index) => {
            const title = stringOf(action.title) ?? stringOf(action.action) ?? stringOf(action.kind) ?? `#${index + 1}`;
            const target = stringOf(action.bucket) ?? stringOf(action.target);
            const snippet = action.config ?? action.json ?? action.payload;
            return (
              <li key={index}>
                <strong>{title}</strong>
                {target ? <small>{target}</small> : null}
                {stringOf(action.why) ?? stringOf(action.reason) ? <p>{stringOf(action.why) ?? stringOf(action.reason)}</p> : null}
                {snippet && typeof snippet === "object" ? (
                  <pre className="agent-plan-json"><code>{JSON.stringify(snippet, null, 2)}</code></pre>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
      {checklist.length > 0 ? (
        <>
          <h3>{c.checklist}</h3>
          <ul className="agent-plan-checklist">
            {checklist.map((item, index) => <li key={index}>{stringOf(item.text) ?? stringOf(item.title) ?? JSON.stringify(item)}</li>)}
          </ul>
        </>
      ) : null}
      {coverage ? (
        <>
          <h3>{c.simulation}</h3>
          <p className="agent-empty-line">{coverage}</p>
        </>
      ) : null}
      <p className="agent-artifact-note">{c.applyIn}</p>
    </article>
  );
}

/** Findings inside a baseline snapshot, rendered as findings when present. */
function SnapshotFindings({ payload }: { payload: Record<string, unknown> }) {
  const copy = useAgentCopy();
  const c = copy.artifacts.baseline;
  const items = listOf((payload as { findings?: unknown }).findings);
  if (items.length === 0) return null;
  return (
    <>
      <h3>{c.snapshotFindings}</h3>
      <ul className="agent-plan-checklist">
        {items.map((item, index) => (
          <li key={index}>{stringOf(item.title) ?? stringOf(item.finding) ?? JSON.stringify(item)}</li>
        ))}
      </ul>
    </>
  );
}

function CopySnapshot({ payload }: { payload: Record<string, unknown> }) {
  const { t } = useI18n();
  const { copied, copy } = useCopy();
  return (
    <button
      type="button"
      onClick={() => copy(JSON.stringify(payload, null, 2))}
      className="native-ghost-action"
      data-testid="baseline-copy"
    >
      {copied ? t("common.copied") : t("common.copy")}
    </button>
  );
}

/** A baseline or drift artifact as a read-only document: the bounded payload. */
function BaselineDocument({ artifact }: { artifact: TaskArtifact }) {
  const copy = useAgentCopy();
  const { t: tBaseline } = useI18n();
  const c = copy.artifacts.baseline;
  const payload = artifact.payload ?? {};
  const added = listOf(payload.added);
  const resolved = listOf(payload.resolved);
  const still = listOf(payload.still_present);
  const configDiff = listOf(payload.config_changes ?? payload.config_diff);
  const isDrift = artifact.artifact_type === "drift_report";
  const nothing = isDrift && added.length + resolved.length + still.length + configDiff.length === 0;
  const group = (title: string, items: Record<string, unknown>[]) => items.length === 0 ? null : (
    <>
      <h3>{title}</h3>
      <ul className="agent-plan-checklist">
        {items.map((item, index) => (
          <li key={index}>{stringOf(item.title) ?? stringOf(item.finding) ?? stringOf(item.aspect) ?? stringOf(item.bucket) ?? JSON.stringify(item)}</li>
        ))}
      </ul>
    </>
  );
  return (
    <article className="agent-artifact-document" data-testid="artifact-baseline-document">
      <header>
        <strong>{artifact.title || c.kinds[artifact.artifact_type] || artifact.artifact_type}</strong>
        <small title={artifact.created_at}>{timeAgo(artifact.created_at, tBaseline)}</small>
      </header>
      {artifact.summary ? <p>{artifact.summary}</p> : null}
      {isDrift ? (
        <>
          {nothing ? <Empty>{c.noDrift}</Empty> : null}
          {group(c.added, added)}
          {group(c.resolved, resolved)}
          {group(c.stillPresent, still)}
          {group(c.configDiff, configDiff)}
          <p className="agent-artifact-note">{c.estimate}</p>
        </>
      ) : (
        <>
          <h3>{c.snapshot}</h3>
          {/* v1.14 — findings read as findings; the raw snapshot stays one
              click away (copied or folded), never a 12k wall of JSON. */}
          <SnapshotFindings payload={payload} />
          <details className="agent-plan-raw">
            <summary>{c.rawSnapshot}</summary>
            <div className="agent-plan-raw-actions">
              <CopySnapshot payload={payload} />
            </div>
            <pre className="agent-plan-json"><code>{JSON.stringify(payload, null, 2).slice(0, 12_000)}</code></pre>
          </details>
        </>
      )}
    </article>
  );
}

/**
 * The Artifacts panel: a right split beside the Task document that lists what
 * the active task produced — Evidence, Reports, Plans, Baselines & Drift, and
 * Execution detail — and opens one of them as a document inside the panel.
 * It replaces the Review sheet; it is not an overlay (except under a narrow
 * window) and not a second application destination.
 */
export function ArtifactsPanel({
  taskId,
  selection,
  projection,
  provenance = null,
  overlay,
  onOpen,
  onBack,
  onClose,
}: {
  taskId: string;
  selection: ArtifactSelection | null;
  projection: ArtifactsProjection;
  provenance?: TaskProvenance | null;
  overlay: boolean;
  onOpen: (kind: ArtifactKind, id?: string | null) => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const copy = useAgentCopy();
  const { t } = useI18n();
  const c = copy.artifacts;
  // v1.14 — stored timestamps are UTC; rows read as relative time with the
  // full stamp on hover, never a bare UTC slice mistaken for local time.
  const when = (iso?: string | null) =>
    iso ? <span title={iso}>{timeAgo(iso, t) || iso.slice(0, 16)}</span> : null;
  const { detail, executions, plans, baselines, report, reportLoading, error } = projection;
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const documentOpen = selectionOpensDocument(selection);
  // v1.14 — an overlay panel traps focus like every other dialog; a split
  // panel does not (it shares the window with the document).
  const trapRef = useFocusTrap<HTMLElement>(overlay);

  useDismissOnEscape(overlay, onClose);

  // v1.14 — ⌘F covers open panel documents too, not just the transcript.
  useEffect(() => {
    const node = bodyRef.current;
    if (!node) return;
    return registerFindRoot(node);
  }, [overlay, documentOpen]);

  useEffect(() => {
    if (!selection || documentOpen) return;
    const node = bodyRef.current?.querySelector(`#artifacts-${SECTION_ID[selection.kind]}`);
    node?.scrollIntoView({ block: "start" });
  }, [selection, documentOpen]);

  const findings = detail?.findings ?? [];
  // v1.14 — a report needs something to report: an assistant answer, not
  // just a user bubble sitting in the transcript.
  const hasReport = (detail?.messages ?? []).some((message) => message.role === "assistant" && (message.content ?? "").trim());

  let document: ReactNode = null;
  let documentTitle: string = c.title;
  if (documentOpen && selection) {
    if (selection.kind === "report") {
      documentTitle = c.report;
      document = <ReportArtifact report={report} loading={reportLoading} error={error} />;
    } else if (selection.kind === "execution" && selection.id) {
      documentTitle = c.sections.execution;
      document = <ExecutionDetail taskId={taskId} executionId={selection.id} onBack={onBack} />;
    } else if (selection.kind === "plan" && selection.id) {
      const plan = plans.find((item) => item.id === selection.id);
      documentTitle = c.sections.plans;
      document = plan ? <PlanDocument plan={plan} /> : <Empty>{c.empty.plans}</Empty>;
    } else if (selection.kind === "baseline" && selection.id) {
      const artifact = baselines.find((item) => item.id === selection.id);
      documentTitle = c.sections.baselines;
      document = artifact ? <BaselineDocument artifact={artifact} /> : <Empty>{c.empty.baselines}</Empty>;
    } else if (selection.kind === "evidence" && selection.id) {
      documentTitle = c.sections.evidence;
      document = <EvidenceReview detail={detail} sessionId={detail?.id ?? ""} selectedFindingId={selection.id} provenance={provenance} />;
    }
  }

  const panel = (
    <aside
      ref={trapRef}
      tabIndex={-1}
      className="agent-artifacts-panel"
      data-testid="agent-artifacts-panel"
      data-mode={overlay ? "overlay" : "split"}
      role={overlay ? "dialog" : "complementary"}
      aria-modal={false}
      aria-label={c.title}
      onClick={(event) => event.stopPropagation()}
    >
      <header className="agent-artifacts-header">
        {documentOpen ? (
          <button type="button" className="agent-artifacts-back" onClick={onBack} data-testid="artifacts-back" aria-label={c.back} title={c.back}>
            <span className="agent-artifacts-back-icon"><Icon name="chevron" size={14} /></span>
          </button>
        ) : null}
        <strong>{documentTitle}</strong>
        <button type="button" className="agent-artifacts-close" onClick={onClose} aria-label={c.close} title={c.close} data-testid="artifacts-close">
          <Icon name="close" size={15} />
        </button>
      </header>

      <div className="agent-artifacts-body" ref={bodyRef}>
        {error && !documentOpen ? <p className="agent-review-error">{c.error} {error}</p> : null}
        {documentOpen ? document : (
          <>
            <Section kind="evidence" title={c.sections.evidence} count={findings.length}>
              {!detail ? <Empty>{c.loading}</Empty> : (
                <EvidenceReview detail={detail} sessionId={detail.id} selectedFindingId={selection?.findingId ?? null} provenance={provenance} />
              )}
            </Section>

            <Section kind="report" title={c.sections.reports} count={null}>
              {hasReport ? (
                <Row title={c.report} meta={detail?.title ?? null} onOpen={() => onOpen("report", "task")} testId="artifact-report-row" />
              ) : <Empty>{c.empty.reports}</Empty>}
            </Section>

            <Section kind="plan" title={c.sections.plans} count={plans.length}>
              {plans.length === 0 ? <Empty>{c.empty.plans}</Empty> : plans.map((plan) => (
                <Row
                  key={plan.id}
                  title={plan.title || c.sections.plans}
                  meta={`${c.plan.version(plan.version)} · ${c.plan.status[plan.status] ?? plan.status}`}
                  status={plan.status}
                  onOpen={() => onOpen("plan", plan.id)}
                  testId="artifact-plan-row"
                />
              ))}
            </Section>

            <Section kind="baseline" title={c.sections.baselines} count={baselines.length}>
              {baselines.length === 0 ? <Empty>{c.empty.baselines}</Empty> : baselines.map((artifact) => (
                <Row
                  key={artifact.id}
                  title={artifact.title || c.baseline.kinds[artifact.artifact_type] || artifact.artifact_type}
                  meta={artifact.summary ?? when(artifact.created_at)}
                  onOpen={() => onOpen("baseline", artifact.id)}
                  testId="artifact-baseline-row"
                />
              ))}
            </Section>

            <Section kind="execution" title={c.sections.execution} count={executions.length}>
              {executions.length === 0 ? <Empty>{c.empty.execution}</Empty> : (
                <div className="agent-run-list" data-testid="execution-review">
                  {executions.map((execution) => (
                    <button
                      key={execution.id}
                      type="button"
                      className="agent-run-row"
                      data-testid="execution-row"
                      data-execution-id={execution.id}
                      data-status={execution.status}
                      onClick={() => onOpen("execution", execution.id)}
                    >
                      <span className="agent-run-status" data-status={execution.status} aria-hidden />
                      <span className="agent-run-main">
                        <strong>{executionTitle(execution) || c.execution.kinds[execution.kind] || execution.kind}</strong>
                        <small>{[c.execution.statuses[execution.status] ?? execution.status, c.execution.kinds[execution.kind] ?? null].filter(Boolean).join(" · ")} · {when(execution.created_at)}</small>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </Section>
          </>
        )}
      </div>
    </aside>
  );

  if (overlay) {
    return (
      <div className="agent-artifacts-scrim" data-testid="agent-artifacts-scrim" onClick={onClose}>
        {panel}
      </div>
    );
  }
  return panel;
}

export { ARTIFACT_KINDS };
