import type { SessionRun } from "../sessionRuns";

export type AgentTaskState =
  | "idle"
  | "ready"
  | "working"
  | "uploading"
  | "decision"
  | "attention";

/**
 * Product-level state of an Agent task, derived only from runtime truth.
 *
 * A confirmation-required proposal is a real blocking state produced by the
 * backend contract, not a UI inference. It must outrank Ready so a completed
 * model turn cannot make an Agent that is waiting for the user look idle.
 */
export function agentTaskState(run: SessionRun, hasTask: boolean): AgentTaskState {
  if (run.uploading) return "uploading";
  if (run.busy) return "working";
  if (run.proposals?.some((proposal) => proposal.requires_confirmation)) return "decision";
  if (run.error || run.needKey || run.stalled) return "attention";
  return hasTask ? "ready" : "idle";
}
