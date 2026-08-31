import { useEffect, type ReactNode } from "react";
import type { SessionDetail } from "../types";
import { Markdown } from "../components/Markdown";
import { EmptyState } from "../components/EmptyState";
import { EvidenceActivity } from "./EvidenceActivity";
import { useAgentCopy } from "./agentCopy";
import type { TaskProvenance } from "../viz/types";

function EmptyLine({ children }: { children: ReactNode }) {
  return <p className="agent-empty-line">{children}</p>;
}

/** Contextual Evidence review for the active Agent task. */
export function EvidenceReview({
  detail,
  sessionId,
  selectedFindingId = null,
  provenance = null,
}: {
  detail: SessionDetail | null;
  sessionId: string;
  selectedFindingId?: string | null;
  provenance?: TaskProvenance | null;
}) {
  const copy = useAgentCopy();
  const findings = detail?.findings ?? [];
  useEffect(() => {
    if (!selectedFindingId) return;
    const node = document.getElementById(`finding-${selectedFindingId}`);
    node?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [selectedFindingId, findings.length]);

  if (!detail) {
    return (
      <div className="agent-document" data-testid="evidence-review">
        <EmptyState title={copy.selectEvidence} body={copy.evidence.noFindings} />
      </div>
    );
  }

  const memory = detail.agent_memory ?? [];
  const files = detail.attached_files ?? [];
  const summary = detail.summary?.summary_md?.trim();
  const context = typeof detail.context_messages === "number" && typeof detail.message_total === "number"
    ? ` · ${copy.evidence.context(detail.context_messages, detail.message_total)}`
    : "";
  const chainById = new Map((provenance?.findings ?? []).map((item) => [item.id, item]));

  useEffect(() => {
    if (!selectedFindingId) return;
    const node = document.getElementById(`finding-${selectedFindingId}`);
    node?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [selectedFindingId, findings.length]);

  return (
    <article className="agent-document" data-testid="evidence-review">
      <header className="agent-document-heading">
        <p className="agent-eyebrow">{copy.evidence.eyebrow}</p>
        <h1>{detail.title}</h1>
        <p>{copy.evidence.overview(findings.length, memory.length, files.length)}{context}</p>
      </header>

      {summary ? (
        <section className="agent-doc-section agent-summary-section">
          <div className="agent-section-index">01</div>
          <div>
            <h2>{copy.evidence.understanding}</h2>
            <Markdown text={summary} />
          </div>
        </section>
      ) : null}

      <section className="agent-doc-section">
        <div className="agent-section-index">02</div>
        <div>
          <h2>{copy.evidence.findings}</h2>
          {findings.length === 0 ? (
            <EmptyLine>{copy.evidence.noFindings}</EmptyLine>
          ) : (
            <div className="agent-record-list">
              {findings.map((finding) => {
                const linked = chainById.get(finding.id);
                const selected = selectedFindingId === finding.id;
                return (
                <div
                  className="agent-record"
                  key={finding.id}
                  id={`finding-${finding.id}`}
                  data-finding-id={finding.id}
                  data-selected={selected ? "true" : "false"}
                >
                  <div className="agent-record-meta">
                    <span>{finding.severity || "info"}</span>
                    {finding.confidence ? <span>{finding.confidence}</span> : null}
                    {finding.category ? <span>{finding.category}</span> : null}
                    {linked?.source_tool ? <span>{linked.source_tool}</span> : null}
                    {linked?.gap === "no_direct_evidence" ? <span data-testid={`finding-gap-${finding.id}`}>No direct evidence chain</span> : null}
                  </div>
                  <strong>{finding.title || copy.evidence.findings}</strong>
                  {finding.interpretation ? <p>{finding.interpretation}</p> : null}
                </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      <section className="agent-doc-section">
        <div className="agent-section-index">03</div>
        <div>
          <h2>{copy.evidence.memory}</h2>
          {memory.length === 0 ? (
            <EmptyLine>{copy.evidence.noMemory}</EmptyLine>
          ) : (
            <div className="agent-record-list">
              {memory.map((item) => (
                <div className="agent-record" key={item.id}>
                  <div className="agent-record-meta">
                    <span>{item.kind.replace("_", " ")}</span>
                    {item.severity ? <span>{item.severity}</span> : null}
                    {item.confidence ? <span>{item.confidence}</span> : null}
                  </div>
                  <p>{item.text}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="agent-doc-section">
        <div className="agent-section-index">04</div>
        <div>
          <h2>{copy.evidence.attached}</h2>
          {files.length === 0 ? (
            <EmptyLine>{copy.evidence.noFiles}</EmptyLine>
          ) : (
            <div className="agent-file-table">
              {files.map((file) => (
                <div className="agent-file-row" key={file.id}>
                  <span className="agent-file-name">{file.source_filename || file.id}</span>
                  <span>{file.dataset_type}</span>
                  <span>{file.row_count == null ? "—" : file.row_count.toLocaleString()}</span>
                  <span>{file.status || "ready"}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="agent-doc-section agent-activity-section">
        <div className="agent-section-index">05</div>
        <div>
          <div className="agent-section-heading-row">
            <div>
              <h2>{copy.evidence.activity}</h2>
              <p className="agent-section-description">{copy.evidence.activityDescription}</p>
            </div>
          </div>
          <EvidenceActivity sessionId={sessionId} />
        </div>
      </section>
    </article>
  );
}
