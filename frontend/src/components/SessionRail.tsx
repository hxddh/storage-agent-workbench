import { useEffect, useRef, useState } from "react";
import type { SessionSummaryRow } from "../types";
import type { SidecarStatus as Status } from "../hooks/useSidecarHealth";
import { useI18n, type TFunc } from "../i18n";
import { listSessions } from "../api";
import { BrandMark } from "./ui";

const STATUS_KEY: Record<Status, string> = {
  starting: "status.starting",
  connected: "status.connected",
  disconnected: "status.disconnected",
  error: "status.error",
};
const STATUS_DOT: Record<Status, string> = {
  starting: "bg-warn",
  connected: "bg-success",
  disconnected: "bg-danger",
  error: "bg-danger",
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

/** Rail width bounds. Below MIN the titles stop being readable and the rail
 * stops earning its space — collapse instead; above MAX it starves the thread. */
export const MIN_RAIL_WIDTH = 190;
export const MAX_RAIL_WIDTH = 420;
export const DEFAULT_RAIL_WIDTH = 244;

export const clampRailWidth = (px: number) =>
  Math.min(MAX_RAIL_WIDTH, Math.max(MIN_RAIL_WIDTH, Math.round(px)));

/** Calendar buckets, not elapsed-time buckets.
 *
 * "23h ago" can be yesterday or today depending on when you look; people
 * remember work by the day it happened on. So the boundaries are local
 * midnights, and "Last 7 days" means the last seven calendar days — which is
 * how every file browser and mail client the user already knows behaves.
 */
const DAY_BUCKETS = ["today", "yesterday", "week", "month", "older"] as const;
type DayBucket = (typeof DAY_BUCKETS)[number];

export function dayBucket(iso: string, now: Date = new Date()): DayBucket {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "older";
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = Math.floor((midnight - new Date(ms).setHours(0, 0, 0, 0)) / 86_400_000);
  // A clock skew / future timestamp counts as today rather than falling to
  // "older", where it would sort below genuinely old chats.
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return "week";
  if (days < 30) return "month";
  return "older";
}

export type SessionActions = {
  /** Persist a new title. The rail handles collecting it via an inline input. */
  onRename: (s: SessionSummaryRow, title: string) => void;
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
  slow,
  actions,
  width,
  collapsed,
  onOpenPalette,
  onToggleCollapse,
  onResize,
}: {
  /** Current rail width in px (ignored while collapsed). */
  width: number;
  collapsed: boolean;
  /** Open the command palette — the collapsed rail's way back to the sessions
   * it is no longer listing. */
  onOpenPalette: () => void;
  onToggleCollapse: () => void;
  /** Called with a new width while the user drags the edge. */
  onResize: (px: number) => void;
  sessions: SessionSummaryRow[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onOpenSettings: () => void;
  status: Status;
  slow: boolean;
  actions: SessionActions;
}) {
  const { t } = useI18n();
  const [menuId, setMenuId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Server-side search (title + message content), debounced. `results` is null
  // when not searching; otherwise it holds the matching sessions.
  const [results, setResults] = useState<SessionSummaryRow[] | null>(null);

  const q = query.trim();
  useEffect(() => {
    if (!q) {
      setResults(null);
      return;
    }
    let cancelled = false;
    const id = setTimeout(() => {
      listSessions(q)
        .then((rows) => { if (!cancelled) setResults(rows); })
        .catch(() => { if (!cancelled) setResults([]); });
    }, 200);
    return () => { cancelled = true; clearTimeout(id); };
  }, [q]);

  const base = q ? (results ?? []) : sessions;
  const active = base.filter((s) => s.status !== "archived");
  const pinned = active.filter((s) => s.pinned);
  const recent = active.filter((s) => !s.pinned);
  const archived = base.filter((s) => s.status === "archived");
  const noResults = q !== "" && results !== null && results.length === 0;

  const closeAll = () => {
    setMenuId(null);
    setRenamingId(null);
    setConfirmId(null);
  };

  const item = (s: SessionSummaryRow) => {
    const isActive = s.id === activeId;
    const isArchived = s.status === "archived";
    const open = menuId === s.id;
    const renaming = renamingId === s.id;
    const confirming = confirmId === s.id;
    const act = (fn: () => void) => (e: React.MouseEvent) => {
      e.stopPropagation();
      setMenuId(null);
      fn();
    };

    if (renaming) {
      return (
        <div key={s.id} className="mb-px px-1.5 py-1">
          <RenameInput
            initial={s.title || ""}
            onCommit={(name) => {
              setRenamingId(null);
              const trimmed = name.trim();
              if (trimmed && trimmed !== s.title) actions.onRename(s, trimmed);
            }}
            onCancel={() => setRenamingId(null)}
          />
        </div>
      );
    }

    return (
      <div
        key={s.id}
        onClick={() => onSelect(s.id)}
        className={`group relative mb-px flex w-full cursor-pointer items-start rounded-lg py-1.5 pl-3 pr-1.5 text-left transition-colors duration-150 ${
          isActive ? "bg-elevated" : "hover:bg-hover/60"
        }`}
      >
        {isActive && <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-accent" />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            {s.pinned && <PinIcon size={10} />}
            <span className={`truncate text-xs ${isActive ? "text-gray-100" : "text-gray-300 group-hover:text-gray-200"}`}>
              {s.title || t("common.untitled")}
            </span>
          </div>
          <span className="mt-0.5 block truncate text-2xs text-gray-600">{relTime(s.updated_at, t)}</span>
        </div>
        <button
          aria-label={t("menu.more")}
          onClick={(e) => { e.stopPropagation(); setConfirmId(null); setMenuId(open ? null : s.id); }}
          className={`grid h-6 w-6 shrink-0 place-items-center rounded-md text-gray-500 transition-colors hover:bg-hover hover:text-gray-200 ${
            open || confirming ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>
        </button>
        {open && (
          <div className="absolute right-1.5 top-8 z-floating w-40 overflow-hidden rounded-lg border border-edge bg-panel py-1 shadow-pop animate-fade-in">
            <MenuItem onClick={act(() => setRenamingId(s.id))}>{t("menu.rename")}</MenuItem>
            {!isArchived && (
              <MenuItem onClick={act(() => actions.onTogglePin(s))}>{s.pinned ? t("menu.unpin") : t("menu.pin")}</MenuItem>
            )}
            <MenuItem onClick={act(() => actions.onFork(s))}>{t("menu.duplicate")}</MenuItem>
            <MenuItem onClick={act(() => actions.onToggleArchive(s))}>{isArchived ? t("menu.unarchive") : t("menu.archive")}</MenuItem>
            <div className="my-1 border-t border-edge" />
            <MenuItem danger onClick={act(() => setConfirmId(s.id))}>{t("menu.delete")}</MenuItem>
          </div>
        )}
        {confirming && (
          <div className="absolute right-1.5 top-8 z-floating w-48 overflow-hidden rounded-lg border border-edge bg-panel p-3 shadow-pop animate-fade-in" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 text-xs text-gray-200">{t("rail.deleteConfirmShort")}</div>
            <div className="flex justify-end gap-1.5">
              <button
                onClick={(e) => { e.stopPropagation(); setConfirmId(null); }}
                className="rounded-md px-2.5 py-1 text-xs text-gray-300 transition-colors hover:bg-hover hover:text-gray-100"
              >
                {t("rail.cancel")}
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setConfirmId(null); actions.onDelete(s); }}
                className="rounded-md bg-danger px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-danger"
              >
                {t("rail.confirmDelete")}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  };

  // Pointer capture rather than window listeners: the drag keeps tracking even
  // when the cursor outruns the handle, and releases cleanly if the pointer is
  // cancelled (a system gesture, a lost window) instead of sticking.
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => onResize(clampRailWidth(ev.clientX));
    const stop = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  };

  // Collapsed: a narrow strip with just the brand, "new chat" and settings. The
  // rail is navigation, and navigation should be surrenderable on a small screen
  // without losing the two things you reach for most.
  if (collapsed) {
    return (
      <aside
        data-testid="session-rail"
        data-collapsed="true"
        className="flex w-[52px] shrink-0 flex-col items-center gap-1 border-r border-edge bg-sidebar py-3.5"
      >
        <button
          onClick={onToggleCollapse}
          title={t("rail.expand")}
          aria-label={t("rail.expand")}
          aria-expanded={false}
          data-testid="rail-toggle"
          className="grid h-[26px] w-[26px] place-items-center rounded-md border border-edge-strong bg-elevated text-accent-soft transition-colors hover:border-accent/50"
        >
          <BrandMark size={15} />
        </button>
        {/* The way back to your conversations.
          *
          * The collapsed strip offered expand / new chat / settings and nothing
          * else, so with the rail folded there was no route to an existing
          * session at all — you had to unfold it first. That was survivable
          * while folding was a deliberate choice; it stopped being survivable
          * when a narrow window folds the rail for you.
          *
          * The palette rather than a second list: it already searches every
          * session and it is the same surface ⌘K opens, so this is one door to
          * one room instead of a small copy of the rail. */}
        <button
          onClick={onOpenPalette}
          title={t("rail.searchPlaceholder")}
          aria-label={t("rail.searchPlaceholder")}
          data-testid="rail-open-palette"
          className="mt-1.5 grid h-8 w-8 place-items-center rounded-lg text-gray-400 transition-colors hover:bg-hover hover:text-gray-100"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" /><line x1="20" y1="20" x2="16.65" y2="16.65" />
          </svg>
        </button>
        <button
          onClick={onNew}
          title={t("rail.newChat")}
          aria-label={t("rail.newChat")}
          className="mt-1.5 grid h-8 w-8 place-items-center rounded-lg text-gray-400 transition-colors hover:bg-hover hover:text-gray-100"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        <div className="mt-auto flex flex-col items-center gap-2">
          <span
            className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[status]} ${status === "starting" ? "animate-pulse" : ""}`}
            title={status === "starting" && slow ? t("status.slowStart") : t(STATUS_KEY[status])}
          />
          <button
            onClick={onOpenSettings}
            aria-label={t("rail.settingsAria")}
            className="grid h-7 w-7 place-items-center rounded-md text-gray-500 transition-colors hover:bg-hover hover:text-gray-200"
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

  return (
    <aside
      data-testid="session-rail"
      data-collapsed="false"
      style={{ width }}
      className="relative flex shrink-0 flex-col border-r border-edge bg-sidebar"
    >
      {/* Drag handle. A 5px hit area straddling the border — wide enough to grab
          without a visible gutter eating layout. */}
      <div
        onPointerDown={startResize}
        onDoubleClick={() => onResize(DEFAULT_RAIL_WIDTH)}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("rail.resize")}
        data-testid="rail-resize"
        className="absolute -right-[2px] top-0 z-floating h-full w-[5px] cursor-col-resize transition-colors hover:bg-accent/30"
      />
      {/* click-away backdrop for the open item menu / delete confirm */}
      {(menuId || confirmId) && <div className="fixed inset-0 z-sticky" onClick={closeAll} />}

      <div className="group/brand flex items-center gap-2.5 px-3.5 pb-2.5 pt-3.5">
        <div className="grid h-[26px] w-[26px] place-items-center rounded-md border border-edge-strong bg-elevated text-accent-soft">
          <BrandMark size={15} />
        </div>
        <div className="text-sm font-medium tracking-[-0.01em] text-gray-100">{t("app.name")}</div>
        <button
          onClick={onToggleCollapse}
          title={t("rail.collapse")}
          aria-label={t("rail.collapse")}
          aria-expanded
          data-testid="rail-toggle"
          className="ml-auto grid h-6 w-6 place-items-center rounded-md text-gray-600 opacity-0 transition-[color,background-color,opacity] hover:bg-hover hover:text-gray-200 group-hover/brand:opacity-100"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="3" y="4" width="18" height="16" rx="2" /><line x1="9" y1="4" x2="9" y2="20" />
          </svg>
        </button>
      </div>

      <div className="px-2.5 pb-1">
        <button
          onClick={onNew}
          className="group flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-gray-300 transition-colors hover:bg-hover hover:text-gray-100"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-gray-500 transition-colors group-hover:text-accent-soft">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          <span className="flex-1">{t("rail.newChat")}</span>
          <kbd className="rounded border border-edge bg-elevated/70 px-1.5 py-px text-3xs font-medium tracking-wide text-gray-500 opacity-0 transition-opacity group-hover:opacity-100">⌘N</kbd>
        </button>
      </div>

      {/* Session search */}
      <div className="px-2.5 pb-2 pt-0.5">
        <div className="flex items-center gap-1.5 rounded-lg border border-edge bg-elevated/40 px-2.5 py-1.5 transition-colors focus-within:border-edge-strong focus-within:bg-elevated">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0 text-gray-500">
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("rail.searchPlaceholder")}
            className="w-full bg-transparent text-xs text-gray-200 placeholder:text-gray-600 focus:outline-none focus-visible:shadow-none"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              aria-label={t("rail.clearSearch")}
              className="shrink-0 text-gray-600 transition-colors hover:text-gray-300"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
          )}
        </div>
      </div>

      <nav className="flex-1 overflow-auto px-1.5 pb-2">
        {noResults ? (
          <div className="px-3 py-5 text-xs leading-relaxed text-gray-600">{t("rail.noResults")}</div>
        ) : sessions.length === 0 ? (
          <div className="px-3 py-5 text-xs leading-relaxed text-gray-600">{t("rail.noChats")}</div>
        ) : null}

        {pinned.length > 0 && (
          <>
            <div className="px-2 pb-1 pt-2 text-3xs font-medium uppercase tracking-wider text-gray-600">{t("rail.pinned")}</div>
            {pinned.map(item)}
          </>
        )}

        {DAY_BUCKETS.map((bucket) => {
          const rows = recent.filter((s) => dayBucket(s.updated_at) === bucket);
          if (rows.length === 0) return null;
          return (
            <div key={bucket}>
              <div className="px-2 pb-1 pt-2 text-3xs font-medium uppercase tracking-wider text-gray-600">
                {t(`rail.day.${bucket}`)}
              </div>
              {rows.map(item)}
            </div>
          );
        })}

        {archived.length > 0 && (
          <>
            <button
              onClick={() => setShowArchived((v) => !v)}
              className="mt-2 flex w-full items-center gap-1.5 px-2 py-1 text-3xs font-medium uppercase tracking-wider text-gray-600 transition-colors hover:text-gray-400"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" className={`transition-transform ${showArchived ? "rotate-90" : ""}`}>
                <polyline points="9 18 15 12 9 6" />
              </svg>
              {t("rail.archived")} ({archived.length})
            </button>
            {(showArchived || q !== "") && archived.map(item)}
          </>
        )}
      </nav>

      <div className="flex items-center gap-2 border-t border-edge px-3.5 py-2.5">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[status]} ${status === "starting" ? "animate-pulse" : ""}`} />
        <span className="text-2xs text-gray-500">
          {status === "starting" && slow ? t("status.slowStart") : t(STATUS_KEY[status])}
        </span>
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

/** Inline rename field — replaces the session row while editing. Commits on
 * Enter or blur, cancels on Escape. Used instead of window.prompt, which is a
 * no-op inside the Tauri WKWebView. */
function RenameInput({ initial, onCommit, onCancel }: { initial: string; onCommit: (v: string) => void; onCancel: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [val, setVal] = useState(initial);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return; // IME candidate commit, not ours
        if (e.key === "Enter") { e.preventDefault(); onCommit(val); }
        else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      }}
      onBlur={() => onCommit(val)}
      className="w-full rounded-md border border-accent/60 bg-elevated px-2.5 py-1.5 text-xs text-gray-100 outline-none ring-1 ring-accent/30"
    />
  );
}

function MenuItem({ children, onClick, danger }: { children: React.ReactNode; onClick: (e: React.MouseEvent) => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`block w-full px-3 py-1.5 text-left text-xs transition-colors hover:bg-hover ${
        danger ? "text-danger hover:text-danger" : "text-gray-300 hover:text-gray-100"
      }`}
    >
      {children}
    </button>
  );
}
