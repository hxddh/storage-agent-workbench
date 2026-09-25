import type { TaskSummaryRow } from "../types";

/** Backend Session records projected into product-level Agent tasks. The row
 * carries the DURABLE task lifecycle (`task_status`) and the active execution
 * id, so background work stays visible with a cold browser run store (reload,
 * second window, restart). */
export type AgentTaskSummary = TaskSummaryRow & {
  task_status?: "ready" | "working" | "needs_attention" | "archived";
  active_execution_id?: string | null;
};

/** Agent task navigation geometry belongs to the application shell. */
export const MIN_TASK_NAV_WIDTH = 208;
export const MAX_TASK_NAV_WIDTH = 420;
export const DEFAULT_TASK_NAV_WIDTH = 268;

export const clampTaskNavigationWidth = (px: number) =>
  Math.min(MAX_TASK_NAV_WIDTH, Math.max(MIN_TASK_NAV_WIDTH, Math.round(px)));

/** A request from outside the sidebar (native menu) to start a Rename or a
 * Delete confirmation on one task. `key` makes repeated requests distinct. */
export type TaskEditRequest = { id: string; kind: "rename" | "delete"; key: number };

/** Mutations on a durable Agent task. Backend record naming stays behind this boundary. */
export type TaskActions = {
  onRename: (task: AgentTaskSummary, title: string) => void;
  onDelete: (task: AgentTaskSummary) => void;
};
