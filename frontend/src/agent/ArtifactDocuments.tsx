import type { ReactNode } from "react";
import type { RemediationPlan, TaskArtifact } from "../api";
import { Markdown } from "../components/Markdown";
import { useCopy } from "../hooks/useCopy";
import { useI18n } from "../i18n";
import { timeAgo } from "../lib/time";
import { useAgentCopy } from "./agentCopy";

/** Read-only documents for the Task's engine outputs (v2.0: they open in
 * place under the Result, not in a side panel). */

function Empty({ children }: { children: ReactNode }) {
  return <p className="agent-empty-line">{children}</p>;
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
export function PlanDocument({ plan }: { plan: RemediationPlan }) {
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
export function BaselineDocument({ artifact }: { artifact: TaskArtifact }) {
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
