import { useState } from "react";
import { openAgentExecution, openAgentReview } from "../agent/commands";
import type { ProvenanceChain, ProvenanceFinding } from "./types";

function preview(chain: ProvenanceChain | null, gap: string | null) {
  if (gap === "no_direct_evidence" || !chain) {
    return { title: "No direct evidence chain", body: "This finding is not linked to a tool call, Execution, or Artifact." };
  }
  const bits = [chain.tool, chain.created_at?.replace("T", " ").slice(0, 16)].filter(Boolean);
  const cov = chain.coverage;
  if (cov?.object_count != null) bits.push(`${cov.object_count} objects`);
  if (cov?.truncated) bits.push("truncated");
  return { title: chain.tool || chain.kind, body: bits.join(" · ") || chain.kind };
}

export function ProvenanceMark({
  finding,
}: {
  finding: Pick<ProvenanceFinding, "id" | "title" | "interpretation" | "severity" | "chain" | "gap" | "source_run_id">;
}) {
  const [open, setOpen] = useState(false);
  const card = preview(finding.chain, finding.gap);
  const go = () => {
    const chain = finding.chain;
    if (chain?.review === "execution" && (chain.id || finding.source_run_id)) {
      openAgentExecution(chain.id || finding.source_run_id || "");
      return;
    }
    if (chain?.review === "report") {
      openAgentReview("report");
      return;
    }
    openAgentReview("evidence", finding.id);
  };
  return (
    <div className="relative min-w-0">
      <button
        type="button"
        data-testid={`finding-provenance-${finding.id}`}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={go}
        className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-hover"
      >
        <span className="agent-review-list-dot mt-1.5 shrink-0" data-severity={finding.severity ?? "info"} aria-hidden />
        <span className="min-w-0">
          <span className="block text-sm text-gray-100">{finding.title}</span>
          {finding.interpretation ? <span className="mt-0.5 block text-2xs leading-relaxed text-gray-500">{finding.interpretation}</span> : null}
        </span>
      </button>
      {open ? (
        <div
          data-testid="provenance-preview"
          className="absolute left-0 top-full z-floating mt-1 w-72 max-w-[70vw] rounded-lg border border-edge bg-elevated px-3 py-2 text-2xs shadow-elev"
        >
          <div className="font-medium text-gray-200">{card.title}</div>
          <p className="mt-0.5 leading-relaxed text-gray-400">{card.body}</p>
        </div>
      ) : null}
    </div>
  );
}
