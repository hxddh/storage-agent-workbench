import type { SessionSummaryRow } from "../types";
import type { SidecarStatus as Status } from "../hooks/useSidecarHealth";
import { SidecarStatus } from "./SidecarStatus";

const STATUS_DOT: Record<string, string> = {
  active: "bg-emerald-500",
  open: "bg-emerald-500",
  closed: "bg-gray-600",
  archived: "bg-gray-600",
};

/** Slim left rail: New, the session list, and a settings + sidecar footer. */
export function SessionRail({
  sessions,
  activeId,
  onSelect,
  onNew,
  onOpenSettings,
  status,
  service,
  slow,
}: {
  sessions: SessionSummaryRow[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onOpenSettings: () => void;
  status: Status;
  service: string | null;
  slow: boolean;
}) {
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-edge bg-sidebar">
      <div className="flex items-center justify-between px-4 py-4">
        <div>
          <div className="text-sm font-semibold text-gray-100">Storage Agent</div>
          <div className="text-xs text-gray-500">Workbench</div>
        </div>
      </div>

      <div className="px-3">
        <button
          onClick={onNew}
          className={`w-full rounded-lg border border-edge px-3 py-2 text-left text-sm ${
            activeId === null ? "bg-canvas text-gray-100" : "text-gray-300 hover:bg-canvas hover:text-gray-100"
          }`}
        >
          + New investigation
        </button>
      </div>

      <nav className="mt-3 flex-1 overflow-auto px-2">
        {sessions.length === 0 && (
          <div className="px-3 py-4 text-xs text-gray-600">No investigations yet.</div>
        )}
        {sessions.map((s) => (
          <button
            key={s.id}
            onClick={() => onSelect(s.id)}
            className={`mb-1 w-full rounded-md px-3 py-2 text-left ${
              s.id === activeId ? "bg-canvas" : "hover:bg-canvas"
            }`}
          >
            <div className="flex items-center gap-2">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[s.status] ?? "bg-gray-600"}`} />
              <span className="truncate text-sm text-gray-200">{s.title || "Untitled"}</span>
            </div>
            <div className="mt-0.5 truncate pl-3.5 text-[11px] text-gray-600">
              {s.run_count} run{s.run_count === 1 ? "" : "s"} · {s.finding_count} finding
              {s.finding_count === 1 ? "" : "s"}
            </div>
          </button>
        ))}
      </nav>

      <div className="space-y-2 border-t border-edge p-3">
        <button
          onClick={onOpenSettings}
          className="w-full rounded-md px-3 py-2 text-left text-sm text-gray-400 hover:bg-canvas hover:text-gray-200"
        >
          ⚙ Settings & providers
        </button>
        <SidecarStatus status={status} service={service} slow={slow} />
      </div>
    </aside>
  );
}
