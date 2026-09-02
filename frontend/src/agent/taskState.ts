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
 * "working" is DURABLE: an execution queued or running in the Sidecar's task
 * runtime reports `working` through `durableStatus` even when this browser
 * has no live run state at all (a reload, a fresh window, another client's
 * delegation). "decision" (since v1.11) is an execution parked on an inline
 * approval: the worker is alive and waits for the user, live (`run.waiting`)
 * or durable (`needs_decision`). It outranks Ready; a live upload outranks
 * everything. This keeps the task list truthful across reloads, task
 * switches, app restarts and Sidecar restarts (recovery reports needs_attention).
 */
export function agentTaskState(
  run: SessionRun,
  hasTask: boolean,
  hasDurableDecision = false,
  durableStatus?: DurableTaskStatus | string | null,
): AgentTaskState {
  if (run.uploading) return "uploading";
  if (run.busy && run.waiting) return "decision";
  if (run.busy || durableStatus === "working") return "working";
  if (hasDurableDecision || durableStatus === "needs_decision") return "decision";
  if (run.error || run.needKey || run.stalled || durableStatus === "needs_attention") {
    return "attention";
  }
  return hasTask ? "ready" : "idle";
}
