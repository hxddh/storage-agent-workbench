import type { SessionSummaryRow } from "../types";
import type { SidecarStatus as Status } from "../hooks/useSidecarHealth";
import { SidecarStatus } from "./SidecarStatus";

const STATUS_DOT: Record<string, string> = {
  active: "bg-emerald-400",
  open: "bg-emerald-400",
  closed: "bg-gray-600",
  archived: "bg-gray-600",
};

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 604800) return `${Math.floor(s / 86400)}d`;
  return `${Math.floor(s / 604800)}w`;
}

/** Slim left rail: brand, New, the session list, and a settings + sidecar footer. */
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
    <aside className="flex w-[264px] shrink-0 flex-col border-r border-edge bg-sidebar">
      <div className="flex items-center gap-2.5 px-4 pb-3 pt-4">
        <div className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-accent to-emerald-700 text-sm font-bold text-white shadow-glow">
          S
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold text-gray-100">Storage Agent</div>
          <div className="text-[11px] text-gray-500">Workbench</div>
        </div>
      </div>

      <div className="px-3 pb-2">
        <button
          onClick={onNew}
          className={`group flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-all duration-150 active:scale-[0.98] ${
            activeId === null
              ? "border-accent/40 bg-accent/10 text-gray-100"
              : "border-edge bg-elevated text-gray-300 hover:border-edge-strong hover:bg-hover hover:text-gray-100"
          }`}
        >
          <span className="grid h-4 w-4 place-items-center rounded text-base leading-none text-accent-soft">+</span>
          New investigation
        </button>
      </div>

      <div className="px-4 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-gray-600">
        Investigations
      </div>
      <nav className="flex-1 overflow-auto px-2 pb-2">
        {sessions.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-gray-600">
            No investigations yet.
            <br />
            Start one below.
          </div>
        )}
        {sessions.map((s) => {
          const active = s.id === activeId;
          return (
            <button
              key={s.id}
              onClick={() => onSelect(s.id)}
              className={`group mb-0.5 flex w-full flex-col rounded-lg px-3 py-2 text-left transition-colors duration-150 ${
                active ? "bg-elevated" : "hover:bg-hover/60"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[s.status] ?? "bg-gray-600"}`} />
                <span className={`truncate text-[13px] ${active ? "font-medium text-gray-100" : "text-gray-300"}`}>
                  {s.title || "Untitled"}
                </span>
                <span className="ml-auto shrink-0 text-[10px] text-gray-600">{relTime(s.updated_at)}</span>
              </div>
              <div className="mt-0.5 truncate pl-3.5 text-[11px] text-gray-600">
                {s.run_count} run{s.run_count === 1 ? "" : "s"} · {s.finding_count} finding
                {s.finding_count === 1 ? "" : "s"}
              </div>
            </button>
          );
        })}
      </nav>

      <div className="space-y-2 border-t border-edge p-3">
        <button
          onClick={onOpenSettings}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-gray-400 transition-colors hover:bg-hover hover:text-gray-200"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          Settings &amp; providers
        </button>
        <SidecarStatus status={status} service={service} slow={slow} />
      </div>
    </aside>
  );
}
