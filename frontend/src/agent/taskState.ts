import type { SessionRun } from "../sessionRuns";

export type AgentTaskState =
  | "idle"
  | "ready"
  | "working"
  | "uploading"
  | "decision"
  | "attention";

/** The Sidecar's durable task lifecycle (agent_tasks.status, v0.94). */
export type DurableTaskStatus =
  | "ready"
  | "working"
  | "needs_decision"
  | "needs_attention"
  | "archived";

/**
 * Product-level state of an Agent task from live execution plus durable task
 * runtime truth.
 *
 * Live execution outranks a previously persisted Decision because the Agent is
 * actively doing work — and since v0.94 "working" is DURABLE: an execution
 * queued or running in the Sidecar's task runtime reports `working` through
 * `durableStatus` even when this browser has no live run state at all (a
 * reload, a fresh window, another client's delegation). A
 * confirmation-required Decision — live or durable — outranks Ready. This
 * keeps Header and command center truthful across reloads, task switches,
 * app restarts, and Sidecar restarts (where recovery reports needs_attention).
 */
export function agentTaskState(
  run: SessionRun,
  hasTask: boolean,
  hasDurableDecision = false,
  durableStatus?: DurableTaskStatus | string | null,
): AgentTaskState {
  if (run.uploading) return "uploading";
  if (run.busy || durableStatus === "working") return "working";
  if (
    run.proposals?.some((proposal) => proposal.requires_confirmation) ||
    hasDurableDecision ||
    durableStatus === "needs_decision"
  ) {
    return "decision";
  }
  if (run.error || run.needKey || run.stalled || durableStatus === "needs_attention") {
    return "attention";
  }
  return hasTask ? "ready" : "idle";
}
