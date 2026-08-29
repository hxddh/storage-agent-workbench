import type { SessionSummaryRow } from "../types";

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

/** Mutations on a persisted Agent task record. */
export type SessionActions = {
  onRename: (task: SessionSummaryRow, title: string) => void;
  onTogglePin: (task: SessionSummaryRow) => void;
  onFork: (task: SessionSummaryRow) => void;
  onToggleArchive: (task: SessionSummaryRow) => void;
  onDelete: (task: SessionSummaryRow) => void;
};
