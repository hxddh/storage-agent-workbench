import type { SessionSummaryRow } from "../types";

/** Backend session records are projected into Agent tasks at this UI boundary. */
export type AgentTaskSummary = SessionSummaryRow;

/** Agent task navigation geometry belongs to the application shell. */
export const MIN_TASK_NAV_WIDTH = 208;
export const MAX_TASK_NAV_WIDTH = 420;
export const DEFAULT_TASK_NAV_WIDTH = 268;

export const clampTaskNavigationWidth = (px: number) =>
  Math.min(MAX_TASK_NAV_WIDTH, Math.max(MIN_TASK_NAV_WIDTH, Math.round(px)));

export const DAY_BUCKETS = ["today", "yesterday", "week", "month", "older"] as const;
export type DayBucket = (typeof DAY_BUCKETS)[number];

/** Calendar buckets, not elapsed-time buckets. */
export function dayBucket(iso: string, now: Date = new Date()): DayBucket {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "older";
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = Math.floor((midnight - new Date(ms).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return "week";
  if (days < 30) return "month";
  return "older";
}

/** Mutations on a durable Agent task. Backend record naming stays behind this boundary. */
export type TaskActions = {
  onRename: (task: AgentTaskSummary, title: string) => void;
  onTogglePin: (task: AgentTaskSummary) => void;
  onFork: (task: AgentTaskSummary) => void;
  onToggleArchive: (task: AgentTaskSummary) => void;
  onDelete: (task: AgentTaskSummary) => void;
};
