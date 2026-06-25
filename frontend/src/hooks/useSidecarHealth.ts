import { useEffect, useRef, useState } from "react";
import { HEALTH_POLL_INTERVAL_MS, initSidecarBaseUrl, sidecarBaseUrl } from "../config";

export type SidecarStatus = "starting" | "connected" | "disconnected" | "error";

// After this long without a successful health check on first launch, we hint
// that a cold start (PyInstaller self-extract) can take a while.
const SLOW_START_MS = 15000;

interface HealthResponse {
  status: string;
  service: string;
}

export interface SidecarHealth {
  status: SidecarStatus;
  service: string | null;
  /** True while still starting and past the slow-start threshold. */
  slow: boolean;
}

/**
 * Resolves the sidecar URL (dev env / Tauri prod), then polls `GET /health`.
 * Reports starting → connected | disconnected | error, plus a `slow` hint when
 * a first-launch cold start runs long.
 */
export function useSidecarHealth(): SidecarHealth {
  const [status, setStatus] = useState<SidecarStatus>("starting");
  const [service, setService] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const everConnected = useRef(false);
  const startedAt = useRef<number>(Date.now());

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
          everConnected.current = true;
          setStatus("connected");
          setService(data.service);
          setSlow(false);
        } else {
          setStatus("disconnected");
          setService(null);
        }
      } catch {
        if (cancelled) return;
        // Before the first successful connection we are still "starting";
        // afterwards a failure means the sidecar went away ("disconnected").
        if (everConnected.current) {
          setStatus("disconnected");
        } else {
          setStatus("starting");
          setSlow(Date.now() - startedAt.current >= SLOW_START_MS);
        }
        setService(null);
      }
    }

    let id: ReturnType<typeof setInterval> | undefined;
    startedAt.current = Date.now();
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

  return { status, service, slow };
}
