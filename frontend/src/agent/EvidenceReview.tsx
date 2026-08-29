import type { ReactNode } from "react";
import type { SessionDetail } from "../types";
import { Markdown } from "../components/Markdown";
import { EvidenceActivity } from "./EvidenceActivity";
import { useAgentCopy } from "./agentCopy";

function EmptyLine({ children }: { children: ReactNode }) {
  return <p className="workbench-empty-line">{children}</p>;
}

/** Contextual Evidence review for the active Agent task. */
export function EvidenceReview({
  detail,
  sessionId,
}: {
  detail: SessionDetail | null;
  sessionId: string;
}) {
  const copy = useAgentCopy();
  if (!detail) {
    return (
      <div className="workbench-document" data-testid="evidence-review">
        <EmptyLine>{copy.selectEvidence}</EmptyLine>
      </div>
    );
  }

  const findings = detail.findings ?? [];
  const memory = detail.agent_memory ?? [];
  const files = detail.attached_files ?? [];
  const summary = detail.summary?.summary_md?.trim();
  const context = typeof detail.context_messages === "number" && typeof detail.message_total === "number"
    ? ` · ${copy.evidence.context(detail.context_messages, detail.message_total)}`
    : "";

  return (
    <article className="workbench-document" data-testid="evidence-review">
      <header className="workbench-document-heading">
        <p className="workbench-eyebrow">{copy.evidence.eyebrow}</p>
        <h1>{detail.title}</h1>
        <p>{copy.evidence.overview(findings.length, memory.length, files.length)}{context}</p>
      </header>

      {summary ? (
        <section className="workbench-doc-section workbench-summary-section">
          <div className="workbench-section-index">01</div>
          <div>
            <h2>{copy.evidence.understanding}</h2>
            <Markdown text={summary} />
          </div>
        </section>
      ) : null}

      <section className="workbench-doc-section">
        <div className="workbench-section-index">02</div>
        <div>
          <h2>{copy.evidence.findings}</h2>
          {findings.length === 0 ? (
            <EmptyLine>{copy.evidence.noFindings}</EmptyLine>
          ) : (
            <div className="workbench-record-list">
              {findings.map((finding) => (
                <div className="workbench-record" key={finding.id}>
                  <div className="workbench-record-meta">
                    <span>{finding.severity || "info"}</span>
                    {finding.confidence ? <span>{finding.confidence}</span> : null}
                    {finding.category ? <span>{finding.category}</span> : null}
                  </div>
                  <strong>{finding.title || copy.evidence.findings}</strong>
                  {finding.interpretation ? <p>{finding.interpretation}</p> : null}
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="workbench-doc-section">
        <div className="workbench-section-index">03</div>
        <div>
          <h2>{copy.evidence.memory}</h2>
          {memory.length === 0 ? (
            <EmptyLine>{copy.evidence.noMemory}</EmptyLine>
          ) : (
            <div className="workbench-record-list">
              {memory.map((item) => (
                <div className="workbench-record" key={item.id}>
                  <div className="workbench-record-meta">
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

      <section className="workbench-doc-section">
        <div className="workbench-section-index">04</div>
        <div>
          <h2>{copy.evidence.attached}</h2>
          {files.length === 0 ? (
            <EmptyLine>{copy.evidence.noFiles}</EmptyLine>
          ) : (
            <div className="workbench-file-table">
              {files.map((file) => (
                <div className="workbench-file-row" key={file.id}>
                  <span className="workbench-file-name">{file.source_filename || file.id}</span>
                  <span>{file.dataset_type}</span>
                  <span>{file.row_count == null ? "—" : file.row_count.toLocaleString()}</span>
                  <span>{file.status || "ready"}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="workbench-doc-section workbench-activity-section">
        <div className="workbench-section-index">05</div>
        <div>
          <div className="workbench-section-heading-row">
            <div>
              <h2>{copy.evidence.activity}</h2>
              <p className="workbench-section-description">{copy.evidence.activityDescription}</p>
            </div>
          </div>
          <EvidenceActivity sessionId={sessionId} />
        </div>
      </section>
    </article>
  );
}
