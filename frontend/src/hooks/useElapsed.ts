import { useEffect, useState } from "react";

/** A live wall-clock since `startIso` (ticks every second while `live`). */
export function useElapsed(startIso: string | null | undefined, endIso: string | null | undefined, live: boolean, lang = "en"): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);
  if (!startIso) return "";
  const start = Date.parse(startIso);
  const end = live || !endIso ? now : Date.parse(endIso);
  return formatDuration(Math.max(0, end - start), lang);
}

/** "1m 05s" — or "1 分 05 秒" in Chinese. */
export function formatDuration(ms: number, lang = "en"): string {
  const zh = lang.startsWith("zh");
  const [sec, min, hr] = zh ? [" 秒", " 分 ", " 小时 "] : ["s", "m ", "h "];
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}${sec}`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}${min}${String(s % 60).padStart(2, "0")}${sec}`;
  return `${Math.floor(m / 60)}${hr}${String(m % 60).padStart(2, "0")}${zh ? " 分" : "m"}`;
}
