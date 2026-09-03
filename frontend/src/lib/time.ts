import type { TFunc } from "../i18n";

/**
 * Shared relative-time formatting (v1.14): one implementation for the task
 * list, the Artifacts panel, and Execution detail — all timestamps the
 * Sidecar stores are UTC ISO strings, and all rendered times say how the
 * full timestamp is still reachable (title attribute at call sites).
 */
export function timeAgo(iso: string, t: TFunc): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const seconds = Math.max(0, (Date.now() - ms) / 1000);
  if (seconds < 60) return t("time.now");
  if (seconds < 3600) return t("time.mAgo", { n: Math.floor(seconds / 60) });
  if (seconds < 86400) return t("time.hAgo", { n: Math.floor(seconds / 3600) });
  if (seconds < 172800) return t("time.yesterday");
  if (seconds < 604800) return t("time.dAgo", { n: Math.floor(seconds / 86400) });
  return t("time.wAgo", { n: Math.floor(seconds / 604800) });
}

/** Start of the local calendar day `ms` falls on, as a sortable key. */
export function localDayKey(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** The local calendar day before `dayKey`, DST-safe (calendar math, not -24h). */
export function previousDayKey(dayKey: number): number {
  const d = new Date(dayKey);
  d.setDate(d.getDate() - 1);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
