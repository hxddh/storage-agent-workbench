import type { SessionSummaryRow } from "../types";

/** Backend Session records projected into product-level Agent tasks. Durable
 * decision state is supplied by /agent-tasks, not inferred from browser memory.
 * Since v0.94 the row also carries the DURABLE task lifecycle (`task_status`)
 * and the active execution id, so background work and pending decisions stay
 * visible with a cold browser run store (reload, second window, restart). */
export type AgentTaskSummary = SessionSummaryRow & {
  requires_decision: boolean;
  task_status?: "ready" | "working" | "needs_decision" | "needs_attention" | "archived";
  active_execution_id?: string | null;
};

/** Agent task navigation geometry belongs to the application shell. */
export const MIN_TASK_NAV_WIDTH = 208;
export const MAX_TASK_NAV_WIDTH = 420;
export const DEFAULT_TASK_NAV_WIDTH = 268;

export const clampTaskNavigationWidth = (px: number) =>
  Math.min(MAX_TASK_NAV_WIDTH, Math.max(MIN_TASK_NAV_WIDTH, Math.round(px)));

/** Mutations on a durable Agent task. Backend record naming stays behind this boundary. */
export type TaskActions = {
  onRename: (task: AgentTaskSummary, title: string) => void;
  onDelete: (task: AgentTaskSummary) => void;
};
