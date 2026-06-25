import type { SidecarStatus as Status } from "../hooks/useSidecarHealth";

const LABEL: Record<Status, string> = {
  starting: "Starting…",
  connected: "Connected",
  disconnected: "Disconnected",
  error: "Error",
};

const DOT: Record<Status, string> = {
  starting: "bg-amber-400 animate-pulse",
  connected: "bg-emerald-400",
  disconnected: "bg-red-500",
  error: "bg-red-600",
};

// Short, sanitized guidance shown beneath the status chip. No secrets here.
function guidance(status: Status, slow: boolean): string | null {
  if (status === "starting" && slow) {
    return "Sidecar is still starting. First launch may take longer.";
  }
  if (status === "disconnected") {
    return "Can't reach the sidecar. Try restarting the app, or check the sidecar logs.";
  }
  if (status === "error") {
    return "Sidecar error. Try restarting the app, or check the sidecar logs.";
  }
  return null;
}

export function SidecarStatus({
  status,
  service,
  slow = false,
}: {
  status: Status;
  service: string | null;
  slow?: boolean;
}) {
  const label = status === "starting" && slow ? "Starting (slow)…" : LABEL[status];
  const hint = guidance(status, slow);

  return (
    <div data-testid="sidecar-status" data-status={status} data-slow={slow}>
      <div
        className="flex items-center gap-2 rounded-md border border-edge bg-canvas px-3 py-2 text-xs"
        title={service ? `Sidecar service: ${service}` : "Python FastAPI sidecar"}
      >
        <span className={`h-2.5 w-2.5 rounded-full ${DOT[status]}`} aria-hidden />
        <span className="text-gray-300">Sidecar</span>
        <span className="font-medium text-gray-100">{label}</span>
      </div>
      {hint && <p className="mt-1 px-1 text-[11px] leading-tight text-gray-500">{hint}</p>}
    </div>
  );
}
