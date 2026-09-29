import { useEffect, useRef } from "react";
import { getEstate } from "../api";
import { useI18n } from "../i18n";
import { notifyNative } from "./useNativeAgent";

const SEEN_KEY = "saw.watch.seen";
const POLL_MS = 60_000;

function readSeen(): string {
  try { return localStorage.getItem(SEEN_KEY) ?? ""; } catch { return ""; }
}
function writeSeen(value: string) {
  try { localStorage.setItem(SEEN_KEY, value); } catch { /* per-device convenience */ }
}

/**
 * v4.0 — when a watch sweep found something new, say so once: one OS
 * notification per sweep, and the task list refreshes so the task the watch
 * opened appears. Reads the estate on a low-frequency clock while the Sidecar
 * is up (the sweep runs on the Sidecar's own clock; this only notices it).
 */
export function useWatchAlerts(sidecarReady: boolean, onFound: () => void) {
  const { t, lang } = useI18n();
  const onFoundRef = useRef(onFound);
  onFoundRef.current = onFound;
  useEffect(() => {
    if (!sidecarReady) return;
    let cancelled = false;
    const check = async () => {
      try {
        const estate = await getEstate(lang);
        if (cancelled) return;
        const seen = readSeen();
        let newest = seen;
        for (const provider of estate.providers) {
          const at = provider.watch.last_run_at;
          if (!at || provider.watch.last_status !== "found") continue;
          if (at > newest) newest = at;
          // The first read on a device only records where it starts.
          if (!seen || at <= seen) continue;
          void notifyNative(t("watch.notifyTitle", { name: provider.name }), provider.watch.last_summary ?? "");
          onFoundRef.current();
        }
        if (newest !== seen || !seen) writeSeen(newest || new Date().toISOString());
      } catch {
        /* offline: the next tick tries again */
      }
    };
    void check();
    const id = window.setInterval(check, POLL_MS);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [sidecarReady, lang, t]);
}
