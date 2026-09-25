import type { LiveTask } from "../liveTasks";

export type AgentTaskState =
  | "idle"
  | "ready"
  | "working"
  | "uploading"
  | "attention";

/** The Sidecar's durable task lifecycle (agent_tasks.status, v0.94). */
export type DurableTaskStatus =
  | "ready"
  | "working"
  | "needs_attention"
  | "archived";

/**
 * Product-level state of an Agent task from live execution plus durable task
 * runtime truth.
 *
 * "working" is DURABLE: an execution queued or running in the Sidecar's task
 * runtime reports `working` through `durableStatus` even when this browser
 * has no live run state at all (a reload, a fresh window, another client's
 * delegation). Nothing waits for the user (v2.1), so there is no decision
 * state; a live upload outranks everything. This keeps the task list truthful across reloads, task
 * switches, app restarts and Sidecar restarts (recovery reports needs_attention).
 */
export function agentTaskState(
  run: LiveTask,
  hasTask: boolean,
  durableStatus?: DurableTaskStatus | string | null,
): AgentTaskState {
  if (run.uploading) return "uploading";
  if (run.busy || durableStatus === "working") return "working";
  if (run.error || run.needKey || run.stalled || durableStatus === "needs_attention") {
    return "attention";
  }
  return hasTask ? "ready" : "idle";
}
