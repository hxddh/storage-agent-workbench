import type { SessionSummaryRow } from "../types";
import type { SidecarStatus as Status } from "../hooks/useSidecarHealth";

const STATUS_LABEL: Record<Status, string> = {
  starting: "Connecting…",
  connected: "Connected",
  disconnected: "Disconnected",
  error: "Error",
};
const STATUS_DOT: Record<Status, string> = {
  starting: "bg-amber-400",
  connected: "bg-emerald-400",
  disconnected: "bg-red-500",
  error: "bg-red-600",
};

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 172800) return "yesterday";
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return `${Math.floor(s / 604800)}w ago`;
}

/** Slim left rail: brand, New chat, recent chats, and a status + settings footer. */
export function SessionRail({
  sessions,
  activeId,
  onSelect,
  onNew,
  onOpenSettings,
  status,
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
    <aside className="flex w-[244px] shrink-0 flex-col border-r border-edge bg-sidebar">
      <div className="flex items-center gap-2.5 px-3.5 pb-2.5 pt-3.5">
        <div className="grid h-[26px] w-[26px] place-items-center rounded-md border border-edge-strong bg-elevated text-accent-soft">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
            <path d="M12 2 2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
          </svg>
        </div>
        <div className="text-[13px] font-medium tracking-[-0.01em] text-gray-100">Storage Agent</div>
      </div>

      <div className="px-2.5 pb-1.5">
        <button
          onClick={onNew}
          className="group flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-gray-300 transition-colors hover:bg-hover hover:text-gray-100"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-accent-soft">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          New chat
        </button>
      </div>

      <div className="px-3.5 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-gray-600">Recent</div>
      <nav className="flex-1 overflow-auto px-1.5 pb-2">
        {sessions.length === 0 && (
          <div className="px-3 py-5 text-[12px] leading-relaxed text-gray-600">No chats yet.</div>
        )}
        {sessions.map((s) => {
          const active = s.id === activeId;
          return (
            <button
              key={s.id}
              onClick={() => onSelect(s.id)}
              className={`group relative mb-px flex w-full flex-col rounded-lg py-[7px] pl-3 pr-2.5 text-left transition-colors duration-150 ${
                active ? "bg-elevated" : "hover:bg-hover/60"
              }`}
            >
              {active && <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-accent" />}
              <span className={`truncate text-[12.5px] ${active ? "text-gray-100" : "text-gray-300 group-hover:text-gray-200"}`}>
                {s.title || "Untitled"}
              </span>
              <span className="mt-0.5 truncate text-[11px] text-gray-600">{relTime(s.updated_at)}</span>
            </button>
          );
        })}
      </nav>

      <div className="flex items-center gap-2 border-t border-edge px-3.5 py-2.5">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[status]} ${status === "starting" ? "animate-pulse" : ""}`} />
        <span className="text-[11.5px] text-gray-500">{STATUS_LABEL[status]}</span>
        <button
          onClick={onOpenSettings}
          aria-label="Settings and providers"
          className="ml-auto grid h-7 w-7 place-items-center rounded-md text-gray-500 transition-colors hover:bg-hover hover:text-gray-200"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>
    </aside>
  );
}
