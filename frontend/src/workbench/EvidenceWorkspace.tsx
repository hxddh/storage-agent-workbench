import type { SessionDetail } from "../types";
import { Markdown } from "../components/Markdown";

function EmptyLine({ children }: { children: React.ReactNode }) {
  return <p className="workbench-empty-line">{children}</p>;
}

export function EvidenceWorkspace({ detail }: { detail: SessionDetail | null }) {
  if (!detail) {
    return (
      <div className="workbench-document" data-testid="evidence-workspace">
        <EmptyLine>Select an investigation to review its evidence.</EmptyLine>
      </div>
    );
  }

  const findings = detail.findings ?? [];
  const memory = detail.agent_memory ?? [];
  const files = detail.attached_files ?? [];
  const summary = detail.summary?.summary_md?.trim();

  return (
    <article className="workbench-document" data-testid="evidence-workspace">
      <header className="workbench-document-heading">
        <p className="workbench-eyebrow">Evidence</p>
        <h1>{detail.title}</h1>
        <p>
          {findings.length} findings · {memory.length} remembered facts/questions · {files.length} files
          {typeof detail.context_messages === "number" && typeof detail.message_total === "number"
            ? ` · context ${detail.context_messages}/${detail.message_total} messages`
            : ""}
        </p>
      </header>

      {summary && (
        <section className="workbench-doc-section workbench-summary-section">
          <div className="workbench-section-index">01</div>
          <div>
            <h2>Current understanding</h2>
            <Markdown text={summary} />
          </div>
        </section>
      )}

      <section className="workbench-doc-section">
        <div className="workbench-section-index">02</div>
        <div>
          <h2>Findings</h2>
          {findings.length === 0 ? (
            <EmptyLine>No persisted findings yet.</EmptyLine>
          ) : (
            <div className="workbench-record-list">
              {findings.map((finding) => (
                <div className="workbench-record" key={finding.id}>
                  <div className="workbench-record-meta">
                    <span>{finding.severity || "info"}</span>
                    {finding.confidence && <span>{finding.confidence}</span>}
                    {finding.category && <span>{finding.category}</span>}
                  </div>
                  <strong>{finding.title || "Finding"}</strong>
                  {finding.interpretation && <p>{finding.interpretation}</p>}
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="workbench-doc-section">
        <div className="workbench-section-index">03</div>
        <div>
          <h2>Agent memory</h2>
          {memory.length === 0 ? (
            <EmptyLine>No durable memory has been recorded for this investigation.</EmptyLine>
          ) : (
            <div className="workbench-record-list">
              {memory.map((item) => (
                <div className="workbench-record" key={item.id}>
                  <div className="workbench-record-meta">
                    <span>{item.kind.replace("_", " ")}</span>
                    {item.severity && <span>{item.severity}</span>}
                    {item.confidence && <span>{item.confidence}</span>}
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
          <h2>Attached evidence</h2>
          {files.length === 0 ? (
            <EmptyLine>No files are attached to this investigation.</EmptyLine>
          ) : (
            <div className="workbench-file-table">
              {files.map((file) => (
                <div className="workbench-file-row" key={file.id}>
                  <span className="workbench-file-name">{file.source_filename || file.id}</span>
                  <span>{file.dataset_type}</span>
                  <span>{file.row_count == null ? "—" : `${file.row_count.toLocaleString()} rows`}</span>
                  <span>{file.status || "ready"}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </article>
  );
}
