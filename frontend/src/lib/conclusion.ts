import type { Conclusion, ConclusionFinding, ConclusionSeverity } from "../types";

const SEVERITIES: readonly ConclusionSeverity[] = ["high", "medium", "low", "info"];

/** Severity order, most severe first — the order findings are read in. */
export const SEVERITY_RANK: Record<ConclusionSeverity, number> = { high: 0, medium: 1, low: 2, info: 3 };

/**
 * Accept a conclusion from the wire (an event payload or a persisted message)
 * only in the shape the runtime records. Anything else is `null`: the page
 * then shows the answer alone — it never invents a head from prose.
 */
export function asConclusion(raw: unknown): Conclusion | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const answer = typeof value.answer === "string" ? value.answer.trim() : "";
  if (!answer) return null;
  const findings: ConclusionFinding[] = [];
  for (const item of Array.isArray(value.findings) ? value.findings : []) {
    if (!item || typeof item !== "object") continue;
    const f = item as Record<string, unknown>;
    const title = typeof f.title === "string" ? f.title.trim() : "";
    if (!title) continue;
    const severity = SEVERITIES.includes(f.severity as ConclusionSeverity) ? (f.severity as ConclusionSeverity) : "info";
    const detail = typeof f.detail === "string" && f.detail.trim() ? f.detail.trim() : undefined;
    findings.push(detail ? { title, severity, detail } : { title, severity });
  }
  findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const nextSteps = (Array.isArray(value.next_steps) ? value.next_steps : [])
    .filter((step): step is string => typeof step === "string" && step.trim().length > 0)
    .map((step) => step.trim());
  return { answer, findings, next_steps: nextSteps };
}

/** The most severe finding's severity, or null when there are none. */
export function topSeverity(conclusion: Conclusion | null | undefined): ConclusionSeverity | null {
  const first = conclusion?.findings[0];
  return first ? first.severity : null;
}
