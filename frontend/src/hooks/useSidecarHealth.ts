import { useEffect, useState } from "react";
import { HEALTH_POLL_INTERVAL_MS, initSidecarBaseUrl, sidecarBaseUrl } from "../config";

export type SidecarStatus = "starting" | "connected" | "disconnected" | "error";

interface HealthResponse {
  status: string;
  service: string;
}

/**
 * Resolves the sidecar URL (dev env / Tauri prod), then polls `GET /health` and
 * reports connection status: starting → connected | disconnected | error.
 */
export function useSidecarHealth(): { status: SidecarStatus; service: string | null } {
  const [status, setStatus] = useState<SidecarStatus>("starting");
  const [service, setService] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const res = await fetch(`${sidecarBaseUrl()}/health`, { signal: controller.signal });
        clearTimeout(timeout);

        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as HealthResponse;
        if (cancelled) return;

        if (data.status === "ok") {
          setStatus("connected");
          setService(data.service);
        } else {
          setStatus("disconnected");
          setService(null);
        }
      } catch {
        if (cancelled) return;
        setStatus("disconnected");
        setService(null);
      }
    }

    let id: ReturnType<typeof setInterval> | undefined;
    // Resolve the URL first (Tauri command in prod), then begin polling.
    initSidecarBaseUrl()
      .catch(() => undefined)
      .finally(() => {
        if (cancelled) return;
        check();
        id = setInterval(check, HEALTH_POLL_INTERVAL_MS);
      });

    return () => {
      cancelled = true;
      if (id) clearInterval(id);
    };
  }, []);

  return { status, service };
}
