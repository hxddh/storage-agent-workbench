import { useEffect, useState } from "react";
import { HEALTH_POLL_INTERVAL_MS, SIDECAR_BASE_URL } from "../config";

export type SidecarStatus = "connecting" | "connected" | "disconnected";

interface HealthResponse {
  status: string;
  service: string;
}

/**
 * Polls the sidecar `GET /health` endpoint and reports connection status.
 * Phase 01: this is the only sidecar interaction the frontend performs.
 */
export function useSidecarHealth(): { status: SidecarStatus; service: string | null } {
  const [status, setStatus] = useState<SidecarStatus>("connecting");
  const [service, setService] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const res = await fetch(`${SIDECAR_BASE_URL}/health`, {
          signal: controller.signal,
        });
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

    check();
    const id = setInterval(check, HEALTH_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return { status, service };
}
