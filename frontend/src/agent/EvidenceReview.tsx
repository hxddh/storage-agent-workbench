import { useEffect, type ReactNode } from "react";
import type { SessionDetail } from "../types";
import { Markdown } from "../components/Markdown";
import { SeverityMark, confidenceLabel } from "../components/SeverityMark";
import { useI18n } from "../i18n";
import { useAgentCopy } from "./agentCopy";
import type { TaskProvenance } from "../viz/types";

function EmptyLine({ children }: { children: ReactNode }) {
  return <p className="agent-empty-line">{children}</p>;
}

/** Contextual Evidence review for the active Agent task. */
export function EvidenceReview({
  detail,
  selectedFindingId = null,
  provenance = null,
}: {
  detail: SessionDetail | null;
  sessionId: string;
  selectedFindingId?: string | null;
  provenance?: TaskProvenance | null;
}) {
  const copy = useAgentCopy();
  const { t } = useI18n();
  const findings = detail?.findings ?? [];
  useEffect(() => {
    if (!selectedFindingId) return;
    const node = document.getElementById(`finding-${selectedFindingId}`);
    node?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [selectedFindingId, findings.length]);

  if (!detail) {
    return (
      <div data-testid="evidence-review">
        <p className="agent-review-empty">{copy.evidence.noFindings}</p>
      </div>
    );
  }

  const files = detail.attached_files ?? [];
  const summary = detail.summary?.summary_md?.trim();
  const chainById = new Map((provenance?.findings ?? []).map((item) => [item.id, item]));

  return (
    <article data-testid="evidence-review" className="agent-review-artifact">
      {summary ? (
        <section className="agent-review-block">
          <h2>{copy.evidence.understanding}</h2>
          <Markdown text={summary} />
        </section>
      ) : null}

      <section className="agent-review-block">
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
                    <SeverityMark severity={finding.severity} />
                    {finding.confidence ? <span>{confidenceLabel(finding.confidence, t)}</span> : null}
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
      </section>

      {files.length > 0 ? (
        <section className="agent-review-block">
          <h2>{copy.evidence.attached}</h2>
          <div className="agent-file-table">
            {files.map((file) => (
              <div className="agent-file-row" key={file.id}>
                <span className="agent-file-name">{file.source_filename || file.id}</span>
                <span>{file.status || t("evidence.statusReady")}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </article>
  );
}
