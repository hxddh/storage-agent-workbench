import type { Conclusion, ConclusionSeverity, TaskFinding } from "../types";
import type { ProvenanceFinding } from "../viz/types";
import { SEVERITY_RANK } from "./conclusion";

/**
 * v3.1 — one findings model. A Task used to show two lists that did not
 * agree: the conclusion's findings in the Result, and the findings recorded
 * during the work in the Evidence pane (with its own count). Both
 * surfaces now read this one list: the recorded conclusion first, then the
 * work's findings it does not already state, deduplicated on their
 * words and ordered most severe first. A finding keeps its evidence chain
 * whenever the work recorded one — nothing here is inferred.
 */
export type UnifiedFinding = {
  /** The recorded finding's id when there is one (so provenance can point
   * at it), else a stable conclusion index. */
  id: string;
  title: string;
  severity: ConclusionSeverity;
  detail?: string;
  source: "conclusion" | "recorded";
  confidence?: string | null;
  provenance?: ProvenanceFinding | null;
};

const ALIASES: Record<string, ConclusionSeverity> = {
  critical: "high", high: "high", warning: "medium", warn: "medium", medium: "medium",
  moderate: "medium", low: "low", minor: "low", info: "info", none: "info", ok: "info",
};

export function normalizeSeverity(raw: unknown): ConclusionSeverity {
  return ALIASES[String(raw ?? "info").trim().toLowerCase()] ?? "info";
}

const key = (text: unknown) => String(text ?? "").toLowerCase().split(/\s+/).filter(Boolean).join(" ");

export function unifyFindings(
  conclusion: Conclusion | null | undefined,
  recorded: ReadonlyArray<TaskFinding | ProvenanceFinding> | null | undefined,
  provenance?: ReadonlyArray<ProvenanceFinding> | null,
): UnifiedFinding[] {
  const chains = new Map<string, ProvenanceFinding>();
  for (const item of provenance ?? []) chains.set(item.id, item);
  const recordedByKey = new Map<string, TaskFinding | ProvenanceFinding>();
  for (const item of recorded ?? []) {
    const k = key(item.title);
    if (k && !recordedByKey.has(k)) recordedByKey.set(k, item);
  }

  const out: UnifiedFinding[] = [];
  const seen = new Set<string>();
  (conclusion?.findings ?? []).forEach((finding, index) => {
    const k = key(finding.title);
    if (!k || seen.has(k)) return;
    seen.add(k);
    const match = recordedByKey.get(k);
    out.push({
      id: match?.id ?? `conclusion-${index}`,
      title: finding.title,
      severity: finding.severity,
      detail: finding.detail,
      source: "conclusion",
      confidence: match?.confidence ?? null,
      // `null` = the chains were read and none backs this finding;
      // `undefined` = no chains were supplied (a live head), nothing to say.
      provenance: match ? chains.get(match.id) ?? null : provenance ? null : undefined,
    });
  });
  for (const item of recorded ?? []) {
    const k = key(item.title);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push({
      id: item.id,
      title: String(item.title),
      severity: normalizeSeverity(item.severity),
      detail: item.interpretation ?? undefined,
      source: "recorded",
      confidence: item.confidence,
      provenance: chains.get(item.id) ?? null,
    });
  }
  // Stable: within a severity the conclusion's own order is kept.
  return out
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity] || a.index - b.index)
    .map(({ finding }) => finding);
}
