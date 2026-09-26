import { useEffect, useState } from "react";
import type { TaskRecord } from "../types";
import { Markdown } from "../components/Markdown";
import { severityLabel, confidenceLabel } from "../components/SeverityMark";
import { Badge, SectionLabel, type Tone } from "../components/ui";
import { Icon } from "../components/icons";
import { useI18n } from "../i18n";
import { useAgentCopy } from "./agentCopy";
import { humanizeTool } from "../lib/format";
import { revealInScroller } from "../lib/scroll";
import type { UnifiedFinding } from "../lib/findings";

const SEVERITY_TONE: Record<string, Tone> = { high: "danger", medium: "warn", low: "neutral", info: "outline" };

function EvidenceFinding({ finding, selected }: { finding: UnifiedFinding; selected: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(selected);
  useEffect(() => { if (selected) setOpen(true); }, [selected]);
  const chain = finding.provenance?.chain ?? null;
  const gap = finding.provenance?.gap ?? null;
  const tool = chain?.tool ?? finding.provenance?.source_tool ?? null;
  const meta = [
    finding.source === "conclusion" ? t("findings.inConclusion") : t("findings.recorded"),
    finding.confidence ? confidenceLabel(finding.confidence, t) : null,
    tool ? humanizeTool(tool) : null,
    chain?.created_at ? chain.created_at.replace("T", " ").slice(0, 16) : null,
  ].filter(Boolean) as string[];
  return (
    <li
      className="evidence-finding"
      id={`finding-${finding.id}`}
      data-finding-id={finding.id}
      data-selected={selected ? "true" : "false"}
      data-source={finding.source}
    >
      <button type="button" className="evidence-finding-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Badge tone={SEVERITY_TONE[finding.severity] ?? "neutral"} className="result-finding-badge" data-severity={finding.severity}>
          {severityLabel(finding.severity, t)}
        </Badge>
        <span className="evidence-finding-title">{finding.title}</span>
        <span className="evidence-finding-chevron" aria-hidden><Icon name="chevron" size={14} /></span>
      </button>
      {open ? (
        <div className="evidence-finding-body">
          {finding.detail ? <p>{finding.detail}</p> : null}
          <p className="evidence-finding-meta">{meta.join(" · ")}</p>
          {gap === "no_direct_evidence" ? (
            <p className="evidence-finding-gap" data-testid={`finding-gap-${finding.id}`}>{t("viz.noChain")}</p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/**
 * v3.1 — the Evidence tab reads the same findings list as the Result (the
 * recorded conclusion joined by what the work recorded), each with
 * where it came from; then the Agent's current understanding and the files
 * attached to the Task.
 */
export function EvidenceReview({
  detail,
  findings,
  selectedFindingId = null,
}: {
  detail: TaskRecord | null;
  findings: UnifiedFinding[];
  selectedFindingId?: string | null;
}) {
  const copy = useAgentCopy();
  const { t } = useI18n();
  useEffect(() => {
    if (!selectedFindingId) return;
    const node = document.getElementById(`finding-${selectedFindingId}`);
    revealInScroller(node, "center");
  }, [selectedFindingId, findings.length]);

  const files = detail?.attached_files ?? [];
  const summary = detail?.summary?.summary_md?.trim();

  return (
    <article data-testid="evidence-review" className="evidence-review">
      <section className="evidence-block">
        <SectionLabel count={findings.length || null}>{copy.evidence.findings}</SectionLabel>
        {findings.length === 0 ? (
          <p className="agent-empty-line">{copy.evidence.noFindings}</p>
        ) : (
          <ul className="evidence-findings" data-testid="evidence-findings">
            {findings.map((finding) => (
              <EvidenceFinding key={finding.id} finding={finding} selected={selectedFindingId === finding.id} />
            ))}
          </ul>
        )}
      </section>

      {summary ? (
        <section className="evidence-block">
          <SectionLabel>{copy.evidence.understanding}</SectionLabel>
          <div className="evidence-summary"><Markdown text={summary} /></div>
        </section>
      ) : null}

      {files.length > 0 ? (
        <section className="evidence-block">
          <SectionLabel count={files.length}>{copy.evidence.attached}</SectionLabel>
          <ul className="evidence-files">
            {files.map((file) => (
              <li key={file.id}>
                <Icon name="file" size={14} />
                <span className="evidence-file-name">{file.source_filename || file.id}</span>
                <span className="evidence-file-status">{file.status || t("evidence.statusReady")}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </article>
  );
}
