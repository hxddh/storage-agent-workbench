import { useState } from "react";
import type { SessionSummaryRow } from "../types";
import type { SidecarStatus as Status } from "../hooks/useSidecarHealth";
import { useI18n, type TFunc } from "../i18n";
import { BrandMark } from "./ui";

const STATUS_KEY: Record<Status, string> = {
  starting: "status.starting",
  connected: "status.connected",
  disconnected: "status.disconnected",
  error: "status.error",
};
const STATUS_DOT: Record<Status, string> = {
  starting: "bg-amber-400",
  connected: "bg-emerald-400",
  disconnected: "bg-red-500",
  error: "bg-red-600",
};

function relTime(iso: string, t: TFunc): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return t("time.now");
  if (s < 3600) return t("time.mAgo", { n: Math.floor(s / 60) });
  if (s < 86400) return t("time.hAgo", { n: Math.floor(s / 3600) });
  if (s < 172800) return t("time.yesterday");
  if (s < 604800) return t("time.dAgo", { n: Math.floor(s / 86400) });
  return t("time.wAgo", { n: Math.floor(s / 604800) });
}

export type SessionActions = {
  onRename: (s: SessionSummaryRow) => void;
  onTogglePin: (s: SessionSummaryRow) => void;
  onFork: (s: SessionSummaryRow) => void;
  onToggleArchive: (s: SessionSummaryRow) => void;
  onDelete: (s: SessionSummaryRow) => void;
};

const PinIcon = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M14 4h-4l1 2v5l-3 2v2h4v5l1 1 1-1v-5h4v-2l-3-2V6l1-2z" />
  </svg>
);

/** Slim left rail: brand, New chat, pinned + recent chats (each with a ⋯ menu:
 * rename / pin / duplicate / archive / delete), an archived section, and a
 * status + settings footer. */
export function SessionRail({
  sessions,
  activeId,
  onSelect,
  onNew,
  onOpenSettings,
  status,
  actions,
}: {
  sessions: SessionSummaryRow[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onOpenSettings: () => void;
  status: Status;
  service: string | null;
  slow: boolean;
  actions: SessionActions;
}) {
  const { t } = useI18n();
  const [menuId, setMenuId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const active = sessions.filter((s) => s.status !== "archived");
  const pinned = active.filter((s) => s.pinned);
  const recent = active.filter((s) => !s.pinned);
  const archived = sessions.filter((s) => s.status === "archived");

  const item = (s: SessionSummaryRow) => {
    const isActive = s.id === activeId;
    const isArchived = s.status === "archived";
    const open = menuId === s.id;
    const act = (fn: () => void) => (e: React.MouseEvent) => {
      e.stopPropagation();
      setMenuId(null);
      fn();
    };
    return (
      <div
        key={s.id}
        onClick={() => onSelect(s.id)}
        className={`group relative mb-px flex w-full cursor-pointer items-start rounded-lg py-[7px] pl-3 pr-1.5 text-left transition-colors duration-150 ${
          isActive ? "bg-elevated" : "hover:bg-hover/60"
        }`}
      >
        {isActive && <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-accent" />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            {s.pinned && <PinIcon size={10} />}
            <span className={`truncate text-[12.5px] ${isActive ? "text-gray-100" : "text-gray-300 group-hover:text-gray-200"}`}>
              {s.title || "Untitled"}
            </span>
          </div>
          <span className="mt-0.5 block truncate text-[11px] text-gray-600">{relTime(s.updated_at, t)}</span>
        </div>
        <button
          aria-label={t("menu.more")}
          onClick={(e) => { e.stopPropagation(); setMenuId(open ? null : s.id); }}
          className={`grid h-6 w-6 shrink-0 place-items-center rounded-md text-gray-500 transition-all hover:bg-hover hover:text-gray-200 ${
            open ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>
        </button>
        {open && (
          <div className="absolute right-1.5 top-8 z-40 w-40 overflow-hidden rounded-lg border border-edge bg-panel py-1 shadow-pop animate-fade-in">
            <MenuItem onClick={act(() => actions.onRename(s))}>{t("menu.rename")}</MenuItem>
            {!isArchived && (
              <MenuItem onClick={act(() => actions.onTogglePin(s))}>{s.pinned ? t("menu.unpin") : t("menu.pin")}</MenuItem>
            )}
            <MenuItem onClick={act(() => actions.onFork(s))}>{t("menu.duplicate")}</MenuItem>
            <MenuItem onClick={act(() => actions.onToggleArchive(s))}>{isArchived ? t("menu.unarchive") : t("menu.archive")}</MenuItem>
            <div className="my-1 border-t border-edge" />
            <MenuItem danger onClick={act(() => actions.onDelete(s))}>{t("menu.delete")}</MenuItem>
          </div>
        )}
      </div>
    );
  };

  return (
    <aside className="flex w-[244px] shrink-0 flex-col border-r border-edge bg-sidebar">
      {/* click-away backdrop for the open item menu */}
      {menuId && <div className="fixed inset-0 z-30" onClick={() => setMenuId(null)} />}

      <div className="flex items-center gap-2.5 px-3.5 pb-2.5 pt-3.5">
        <div className="grid h-[26px] w-[26px] place-items-center rounded-md border border-edge-strong bg-elevated text-accent-soft">
          <BrandMark size={15} />
        </div>
        <div className="text-[13px] font-medium tracking-[-0.01em] text-gray-100">{t("app.name")}</div>
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
          {t("rail.newChat")}
        </button>
      </div>

      <nav className="flex-1 overflow-auto px-1.5 pb-2">
        {active.length === 0 && (
          <div className="px-3 py-5 text-[12px] leading-relaxed text-gray-600">{t("rail.noChats")}</div>
        )}

        {pinned.length > 0 && (
          <>
            <div className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-gray-600">{t("rail.pinned")}</div>
            {pinned.map(item)}
          </>
        )}

        {recent.length > 0 && (
          <>
            <div className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-gray-600">{t("rail.recent")}</div>
            {recent.map(item)}
          </>
        )}

        {archived.length > 0 && (
          <>
            <button
              onClick={() => setShowArchived((v) => !v)}
              className="mt-2 flex w-full items-center gap-1.5 px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-gray-600 transition-colors hover:text-gray-400"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" className={`transition-transform ${showArchived ? "rotate-90" : ""}`}>
                <polyline points="9 18 15 12 9 6" />
              </svg>
              {t("rail.archived")} ({archived.length})
            </button>
            {showArchived && archived.map(item)}
          </>
        )}
      </nav>

      <div className="flex items-center gap-2 border-t border-edge px-3.5 py-2.5">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[status]} ${status === "starting" ? "animate-pulse" : ""}`} />
        <span className="text-[11.5px] text-gray-500">{t(STATUS_KEY[status])}</span>
        <button
          onClick={onOpenSettings}
          aria-label={t("rail.settingsAria")}
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

function MenuItem({ children, onClick, danger }: { children: React.ReactNode; onClick: (e: React.MouseEvent) => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`block w-full px-3 py-1.5 text-left text-[12.5px] transition-colors hover:bg-hover ${
        danger ? "text-red-400 hover:text-red-300" : "text-gray-300 hover:text-gray-100"
      }`}
    >
      {children}
    </button>
  );
}
