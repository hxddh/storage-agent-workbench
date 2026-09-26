import { useState } from "react";
import { openAgentReview } from "../agent/commands";
import { useI18n, type TFunc } from "../i18n";
import type { ProvenanceChain, ProvenanceFinding } from "./types";
import { humanizeTool } from "../lib/format";
import { Icon } from "../components/icons";

function preview(chain: ProvenanceChain | null, gap: string | null, t: TFunc) {
  if (gap === "no_direct_evidence" || !chain) {
    return { title: t("viz.noChain"), body: t("viz.noChainBody") };
  }
  // v1.19 — the tool names the preview once (as its title), in words; the
  // body carries only what the title does not: when, and how much.
  const bits: string[] = [chain.created_at?.replace("T", " ").slice(0, 16) ?? ""].filter(Boolean);
  const cov = chain.coverage;
  if (cov?.object_count != null) bits.push(t("viz.objects", { n: cov.object_count }));
  if (cov?.truncated) bits.push(t("viz.truncated"));
  return { title: humanizeTool(chain.tool) || chain.kind, body: bits.join(" · ") || chain.kind };
}

/**
 * v3.1 — a finding's evidence link, inside its row: hover (or focus) previews
 * what the finding stands on; a click opens it in the side pane. A finding the
 * work linked to no call says so rather than pretending.
 */
export function ProvenanceLink({ finding }: { finding: Pick<ProvenanceFinding, "id" | "chain" | "gap"> }) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  const card = preview(finding.chain, finding.gap, t);
  const go = () => {
    const chain = finding.chain;
    // A chain names the deterministic run behind a finding; the Execution
    // tab lists the durable Executions that ran it (v1.12 — the detail
    // document is keyed by execution id, never by run id).
    if (chain?.review === "execution") { openAgentReview("execution"); return; }
    if (chain?.review === "report") { openAgentReview("report"); return; }
    openAgentReview("evidence", finding.id);
  };
  return (
    <span className="provenance-link-wrap">
      <button
        type="button"
        className="provenance-link"
        data-testid={`finding-provenance-${finding.id}`}
        data-gap={finding.gap ?? undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(event) => { event.stopPropagation(); go(); }}
        aria-label={t("findings.evidenceFor")}
      >
        <Icon name="evidence" size={14} />
        <span>{finding.gap === "no_direct_evidence" ? t("findings.noChainShort") : t("findings.evidence")}</span>
      </button>
      {open ? (
        <span data-testid="provenance-preview" className="provenance-preview" role="tooltip">
          <strong>{card.title}</strong>
          <span>{card.body}</span>
        </span>
      ) : null}
    </span>
  );
}
