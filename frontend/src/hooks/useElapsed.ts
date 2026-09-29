import { useEffect, useState } from "react";

/** A live wall-clock since `startIso` (ticks every second while `live`). */
export function useElapsed(startIso: string | null | undefined, endIso: string | null | undefined, live: boolean): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);
  if (!startIso) return "";
  const start = Date.parse(startIso);
  const end = live || !endIso ? now : Date.parse(endIso);
  return formatDuration(Math.max(0, end - start));
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
