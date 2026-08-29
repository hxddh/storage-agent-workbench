import type { SessionRun } from "../sessionRuns";

export type AgentTaskState =
  | "idle"
  | "ready"
  | "working"
  | "uploading"
  | "decision"
  | "attention";

/**
 * Product-level state of an Agent task from live execution plus durable task
 * projection truth.
 *
 * Live execution outranks a previously persisted Decision because the Agent is
 * actively doing work. Otherwise a confirmation-required proposal — whether it
 * arrived in this browser run or was restored from the latest durable Work
 * Result — must outrank Ready. This keeps Header and command center truthful
 * across reloads, task switches, and app restarts.
 */
export function agentTaskState(
  run: SessionRun,
  hasTask: boolean,
  hasDurableDecision = false,
): AgentTaskState {
  if (run.uploading) return "uploading";
  if (run.busy) return "working";
  if (run.proposals?.some((proposal) => proposal.requires_confirmation) || hasDurableDecision) {
    return "decision";
  }
  if (run.error || run.needKey || run.stalled) return "attention";
  return hasTask ? "ready" : "idle";
}
