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

export function SidecarStatus({ status, service }: { status: Status; service: string | null }) {
  return (
    <div
      className="flex items-center gap-2 rounded-md border border-edge bg-canvas px-3 py-2 text-xs"
      title={service ? `Sidecar service: ${service}` : "Python FastAPI sidecar"}
      data-testid="sidecar-status"
      data-status={status}
    >
      <span className={`h-2.5 w-2.5 rounded-full ${DOT[status]}`} aria-hidden />
      <span className="text-gray-300">Sidecar</span>
      <span className="font-medium text-gray-100">{LABEL[status]}</span>
    </div>
  );
}
