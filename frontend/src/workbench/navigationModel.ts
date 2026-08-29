import type { SessionSummaryRow } from "../types";

/**
 * Investigation navigation geometry belongs to the application shell rather
 * than to the historical chat rail implementation. Below MIN the title/context
 * pair stops being useful, so the navigation should collapse instead of being
 * squeezed into an unreadable sliver.
 */
export const MIN_RAIL_WIDTH = 208;
export const MAX_RAIL_WIDTH = 420;
export const DEFAULT_RAIL_WIDTH = 268;

export const clampRailWidth = (px: number) =>
  Math.min(MAX_RAIL_WIDTH, Math.max(MIN_RAIL_WIDTH, Math.round(px)));

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

export type SessionActions = {
  onRename: (session: SessionSummaryRow, title: string) => void;
  onTogglePin: (session: SessionSummaryRow) => void;
  onFork: (session: SessionSummaryRow) => void;
  onToggleArchive: (session: SessionSummaryRow) => void;
  onDelete: (session: SessionSummaryRow) => void;
};
