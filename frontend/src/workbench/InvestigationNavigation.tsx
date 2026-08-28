import { useEffect, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { listSessions } from "../api";
import { useI18n, type TFunc } from "../i18n";
import type { SidecarStatus } from "../hooks/useSidecarHealth";
import { useSessionRun } from "../sessionRuns";
import type { SessionSummaryRow } from "../types";
import { BrandMark } from "../components/ui";
import { useNavigationCopy } from "./navigationCopy";
import {
  DAY_BUCKETS,
  DEFAULT_RAIL_WIDTH,
  clampRailWidth,
  dayBucket,
  type SessionActions,
} from "./navigationModel";

const STATUS_KEY: Record<SidecarStatus, string> = {
  starting: "status.starting",
  connected: "status.connected",
  disconnected: "status.disconnected",
  error: "status.error",
};

const STATUS_DOT: Record<SidecarStatus, string> = {
  starting: "bg-warn",
  connected: "bg-success",
  disconnected: "bg-danger",
  error: "bg-danger",
};

function relTime(iso: string, t: TFunc): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const seconds = Math.max(0, (Date.now() - ms) / 1000);
  if (seconds < 60) return t("time.now");
  if (seconds < 3600) return t("time.mAgo", { n: Math.floor(seconds / 60) });
  if (seconds < 86400) return t("time.hAgo", { n: Math.floor(seconds / 3600) });
  if (seconds < 172800) return t("time.yesterday");
  if (seconds < 604800) return t("time.dAgo", { n: Math.floor(seconds / 86400) });
  return t("time.wAgo", { n: Math.floor(seconds / 604800) });
}

const PinIcon = ({ size = 11 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M14 4h-4l1 2v5l-3 2v2h4v5l1 1 1-1v-5h4v-2l-3-2V6l1-2z" />
  </svg>
);

function MenuItem({
  children,
  onClick,
  danger = false,
}: {
  children: ReactNode;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`block w-full px-3 py-1.5 text-left text-xs transition-colors ${
        danger ? "text-danger hover:bg-danger-bg" : "text-gray-300 hover:bg-hover hover:text-gray-100"
      }`}
    >
      {children}
    </button>
  );
}

function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  return (
    <input
      ref={ref}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => onCommit(value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onCommit(value);
        if (event.key === "Escape") onCancel();
      }}
      className="w-full rounded-md border border-accent/50 bg-elevated px-2 py-1.5 text-xs text-gray-100 outline-none focus:border-accent"
    />
  );
}

function InvestigationRow({
  session,
  activeId,
  menuId,
  renamingId,
  confirmId,
  onSelect,
  setMenuId,
  setRenamingId,
  setConfirmId,
  actions,
}: {
  session: SessionSummaryRow;
  activeId: string | null;
  menuId: string | null;
  renamingId: string | null;
  confirmId: string | null;
  onSelect: (id: string) => void;
  setMenuId: (id: string | null) => void;
  setRenamingId: (id: string | null) => void;
  setConfirmId: (id: string | null) => void;
  actions: SessionActions;
}) {
  const { t } = useI18n();
  const copy = useNavigationCopy();
  const run = useSessionRun(session.id);
  const selected = session.id === activeId;
  const archived = session.status === "archived";
  const menuOpen = menuId === session.id;
  const renaming = renamingId === session.id;
  const confirming = confirmId === session.id;

  if (renaming) {
    return (
      <div className="px-2 py-1" data-testid="investigation-row-rename">
        <RenameInput
          initial={session.title || ""}
          onCommit={(value) => {
            setRenamingId(null);
            const title = value.trim();
            if (title && title !== session.title) actions.onRename(session, title);
          }}
          onCancel={() => setRenamingId(null)}
        />
      </div>
    );
  }

  const activity = run.uploading
    ? { label: copy.uploading, tone: "bg-warn" }
    : run.busy
      ? { label: copy.running, tone: "bg-warn" }
      : run.error || run.needKey
        ? { label: copy.failed, tone: "bg-danger" }
        : { label: copy.ready, tone: "bg-gray-500" };

  const context = session.primary_bucket?.trim() || session.goal?.trim() || copy.contextFallback;
  const counts = `${copy.findingShort(session.finding_count ?? 0)} · ${copy.runShort(session.run_count ?? 0)}`;
  const act = (fn: () => void) => (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setMenuId(null);
    fn();
  };

  return (
    <div
      className={`investigation-nav-row group relative mb-0.5 cursor-pointer rounded-lg px-2.5 py-2 transition-colors ${
        selected ? "bg-elevated" : "hover:bg-hover/55"
      }`}
      data-testid="investigation-row"
      data-selected={selected ? "true" : "false"}
      data-running={run.busy ? "true" : "false"}
      onClick={() => onSelect(session.id)}
      title={`${session.title || t("common.untitled")} — ${relTime(session.updated_at, t)}`}
    >
      {selected ? <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-accent" aria-hidden /> : null}

      <div className="flex min-w-0 items-center gap-2">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${activity.tone} ${run.busy ? "animate-pulse" : ""}`} title={activity.label} />
        <strong className={`min-w-0 flex-1 truncate text-xs font-medium ${selected ? "text-gray-100" : "text-gray-200"}`}>
          {session.title || t("common.untitled")}
        </strong>
        {session.pinned ? <span className="shrink-0 text-gray-500"><PinIcon /></span> : null}
        <button
          type="button"
          aria-label={t("menu.more")}
          onClick={(event) => {
            event.stopPropagation();
            setConfirmId(null);
            setMenuId(menuOpen ? null : session.id);
          }}
          className={`grid h-6 w-6 shrink-0 place-items-center rounded-md text-gray-500 transition-colors hover:bg-hover hover:text-gray-200 ${
            menuOpen || confirming ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100"
          }`}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
          </svg>
        </button>
      </div>

      <div className="mt-1 flex min-w-0 items-center gap-2 pl-3.5 text-[10px] leading-4 text-gray-500">
        <span className="min-w-0 flex-1 truncate" title={context}>{context}</span>
        <span className="shrink-0 font-mono tabular-nums">{counts}</span>
      </div>

      {menuOpen ? (
        <div className="absolute right-1.5 top-8 z-floating w-40 overflow-hidden rounded-lg border border-edge bg-panel py-1 shadow-pop animate-fade-in">
          <MenuItem onClick={act(() => setRenamingId(session.id))}>{t("menu.rename")}</MenuItem>
          {!archived ? (
            <MenuItem onClick={act(() => actions.onTogglePin(session))}>{session.pinned ? t("menu.unpin") : t("menu.pin")}</MenuItem>
          ) : null}
          <MenuItem onClick={act(() => actions.onFork(session))}>{t("menu.duplicate")}</MenuItem>
          <MenuItem onClick={act(() => actions.onToggleArchive(session))}>{archived ? t("menu.unarchive") : t("menu.archive")}</MenuItem>
          <div className="my-1 border-t border-edge" />
          <MenuItem danger onClick={act(() => setConfirmId(session.id))}>{t("menu.delete")}</MenuItem>
        </div>
      ) : null}

      {confirming ? (
        <div
          className="absolute right-1.5 top-8 z-floating w-48 overflow-hidden rounded-lg border border-edge bg-panel p-3 shadow-pop animate-fade-in"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="mb-2 text-xs text-gray-200">{t("rail.deleteConfirmShort")}</div>
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              onClick={(event) => { event.stopPropagation(); setConfirmId(null); }}
              className="rounded-md px-2.5 py-1 text-xs text-gray-300 transition-colors hover:bg-hover hover:text-gray-100"
            >
              {t("rail.cancel")}
            </button>
            <button
              type="button"
              onClick={(event) => { event.stopPropagation(); setConfirmId(null); actions.onDelete(session); }}
              className="rounded-md bg-danger px-2.5 py-1 text-xs font-medium text-white"
            >
              {t("rail.confirmDelete")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export type InvestigationNavigationProps = {
  width: number;
  collapsed: boolean;
  onOpenPalette: () => void;
  onToggleCollapse: () => void;
  onResize: (px: number) => void;
  sessions: SessionSummaryRow[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onOpenSettings: () => void;
  status: SidecarStatus;
  slow: boolean;
  actions: SessionActions;
};

/**
 * Persistent investigation navigation for the Agent OS shell.
 *
 * This is intentionally not a chat-history rail. Each row is an investigation:
 * title, current scope, durable findings/runs and live Agent state are visible at
 * scan speed, while mutation/search mechanics remain the proven server-backed
 * behavior from the earlier rail.
 */
export function InvestigationNavigation({
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
}: InvestigationNavigationProps) {
  const { t } = useI18n();
  const copy = useNavigationCopy();
  const [menuId, setMenuId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SessionSummaryRow[] | null>(null);

  const q = query.trim();
  useEffect(() => {
    if (!q) {
      setResults(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void listSessions(q)
        .then((rows) => { if (!cancelled) setResults(rows); })
        .catch(() => { if (!cancelled) setResults([]); });
    }, 200);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [q]);

  const base = q ? (results ?? []) : sessions;
  const active = base.filter((session) => session.status !== "archived");
  const pinned = active.filter((session) => session.pinned);
  const recent = active.filter((session) => !session.pinned);
  const archived = base.filter((session) => session.status === "archived");
  const noResults = q !== "" && results !== null && results.length === 0;

  const closeAll = () => {
    setMenuId(null);
    setRenamingId(null);
    setConfirmId(null);
  };

  const row = (session: SessionSummaryRow) => (
    <InvestigationRow
      key={session.id}
      session={session}
      activeId={activeId}
      menuId={menuId}
      renamingId={renamingId}
      confirmId={confirmId}
      onSelect={onSelect}
      setMenuId={setMenuId}
      setRenamingId={setRenamingId}
      setConfirmId={setConfirmId}
      actions={actions}
    />
  );

  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const move = (next: globalThis.PointerEvent) => onResize(clampRailWidth(next.clientX));
    const stop = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  };

  if (collapsed) {
    return (
      <aside
        data-testid="session-rail"
        data-navigation="investigations"
        data-collapsed="true"
        aria-label={copy.investigations}
        className="flex w-[52px] shrink-0 flex-col items-center gap-1 border-r border-edge bg-sidebar py-3.5"
      >
        <button
          type="button"
          onClick={onToggleCollapse}
          title={t("rail.expand")}
          aria-label={t("rail.expand")}
          aria-expanded={false}
          data-testid="rail-toggle"
          className="grid h-[26px] w-[26px] place-items-center rounded-md border border-edge-strong bg-elevated text-accent-soft transition-colors hover:border-accent/50"
        >
          <BrandMark size={15} />
        </button>
        <button
          type="button"
          onClick={onOpenPalette}
          title={copy.searchExisting}
          aria-label={copy.searchExisting}
          data-testid="rail-open-palette"
          className="mt-1.5 grid h-8 w-8 place-items-center rounded-lg text-gray-400 transition-colors hover:bg-hover hover:text-gray-100"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <circle cx="11" cy="11" r="7" /><line x1="20" y1="20" x2="16.65" y2="16.65" />
          </svg>
        </button>
        <button
          type="button"
          onClick={onNew}
          title={copy.newInvestigation}
          aria-label={copy.newInvestigation}
          className="mt-1.5 grid h-8 w-8 place-items-center rounded-lg text-gray-400 transition-colors hover:bg-hover hover:text-gray-100"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        <div className="mt-auto flex flex-col items-center gap-2">
          <span
            className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[status]} ${status === "starting" ? "animate-pulse" : ""}`}
            title={status === "starting" && slow ? t("status.slowStart") : t(STATUS_KEY[status])}
          />
          <button
            type="button"
            onClick={onOpenSettings}
            aria-label={t("rail.settingsAria")}
            className="grid h-7 w-7 place-items-center rounded-md text-gray-500 transition-colors hover:bg-hover hover:text-gray-200"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21h-4v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H3v-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3h4a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9A1.7 1.7 0 0 0 21 10h.1v4H21a1.7 1.7 0 0 0-1.6 1Z" />
            </svg>
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside
      data-testid="session-rail"
      data-navigation="investigations"
      data-collapsed="false"
      aria-label={copy.investigations}
      style={{ width }}
      className="relative flex shrink-0 flex-col border-r border-edge bg-sidebar"
    >
      <div
        onPointerDown={startResize}
        onDoubleClick={() => onResize(DEFAULT_RAIL_WIDTH)}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("rail.resize")}
        data-testid="rail-resize"
        className="absolute -right-[2px] top-0 z-floating h-full w-[5px] cursor-col-resize transition-colors hover:bg-accent/30"
      />
      {(menuId || confirmId) ? <div className="fixed inset-0 z-sticky" onClick={closeAll} /> : null}

      <div className="group/brand flex items-center gap-2.5 px-3.5 pb-2 pt-3.5">
        <div className="grid h-[26px] w-[26px] place-items-center rounded-md border border-edge-strong bg-elevated text-accent-soft">
          <BrandMark size={15} />
        </div>
        <div className="min-w-0">
          <div className="truncate text-xs font-semibold tracking-[-0.01em] text-gray-100">{t("app.name")}</div>
          <div className="text-[9px] uppercase tracking-[0.12em] text-gray-500">{copy.investigations}</div>
        </div>
        <button
          type="button"
          onClick={onToggleCollapse}
          title={t("rail.collapse")}
          aria-label={t("rail.collapse")}
          aria-expanded
          data-testid="rail-toggle"
          className="ml-auto grid h-6 w-6 place-items-center rounded-md text-gray-500 opacity-0 transition-[color,background-color,opacity] hover:bg-hover hover:text-gray-200 group-hover/brand:opacity-100 focus:opacity-100"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="3" y="4" width="18" height="16" rx="2" /><line x1="9" y1="4" x2="9" y2="20" />
          </svg>
        </button>
      </div>

      <div className="px-2.5 pb-1">
        <button
          type="button"
          onClick={onNew}
          className="group flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-gray-300 transition-colors hover:bg-hover hover:text-gray-100"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-gray-500 transition-colors group-hover:text-accent-soft" aria-hidden>
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          <span className="flex-1">{copy.newInvestigation}</span>
          <kbd className="rounded border border-edge bg-elevated/70 px-1.5 py-px text-[9px] tracking-wide text-gray-500 opacity-0 transition-opacity group-hover:opacity-100">⌘N</kbd>
        </button>
      </div>

      <div className="px-2.5 pb-2 pt-1">
        <div className="flex items-center gap-1.5 rounded-lg border border-edge bg-elevated/35 px-2.5 py-1.5 transition-colors focus-within:border-edge-strong focus-within:bg-elevated">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0 text-gray-500" aria-hidden>
            <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={copy.search}
            aria-label={copy.search}
            className="w-full bg-transparent text-xs text-gray-200 placeholder:text-gray-500 focus:outline-none focus-visible:shadow-none"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label={copy.clearSearch}
              className="shrink-0 text-gray-500 transition-colors hover:text-gray-300"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          ) : null}
        </div>
      </div>

      <nav className="min-h-0 flex-1 overflow-auto px-1.5 pb-2" aria-label={copy.investigations}>
        {noResults ? (
          <div className="px-3 py-5 text-xs leading-relaxed text-gray-500">{copy.noResults}</div>
        ) : sessions.length === 0 ? (
          <div className="px-3 py-5 text-xs leading-relaxed text-gray-500">{copy.noInvestigations}</div>
        ) : null}

        {pinned.length ? (
          <section aria-label={copy.pinned}>
            <div className="px-2 pb-1 pt-2 text-[9px] font-medium uppercase tracking-[0.11em] text-gray-500">{copy.pinned}</div>
            {pinned.map(row)}
          </section>
        ) : null}

        {DAY_BUCKETS.map((bucket) => {
          const rows = recent.filter((session) => dayBucket(session.updated_at) === bucket);
          if (!rows.length) return null;
          return (
            <section key={bucket} aria-label={t(`rail.day.${bucket}`)}>
              <div className="px-2 pb-1 pt-2 text-[9px] font-medium uppercase tracking-[0.11em] text-gray-500">{t(`rail.day.${bucket}`)}</div>
              {rows.map(row)}
            </section>
          );
        })}

        {archived.length ? (
          <section aria-label={copy.archived}>
            <button
              type="button"
              onClick={() => setShowArchived((value) => !value)}
              className="mt-2 flex w-full items-center gap-1.5 px-2 py-1 text-[9px] font-medium uppercase tracking-[0.11em] text-gray-500 transition-colors hover:text-gray-400"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" className={`transition-transform ${showArchived ? "rotate-90" : ""}`} aria-hidden>
                <polyline points="9 18 15 12 9 6" />
              </svg>
              {copy.archived} ({archived.length})
            </button>
            {(showArchived || q !== "") ? archived.map(row) : null}
          </section>
        ) : null}
      </nav>

      <div className="flex items-center gap-2 border-t border-edge px-3.5 py-2.5">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[status]} ${status === "starting" ? "animate-pulse" : ""}`} aria-hidden />
        <span className="min-w-0 truncate text-[10px] text-gray-500">
          {status === "starting" && slow ? t("status.slowStart") : t(STATUS_KEY[status])}
        </span>
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label={t("rail.settingsAria")}
          data-testid="rail-settings"
          className="ml-auto grid h-7 w-7 place-items-center rounded-md text-gray-500 transition-colors hover:bg-hover hover:text-gray-200"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21h-4v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H3v-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3h4a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9A1.7 1.7 0 0 0 21 10h.1v4H21a1.7 1.7 0 0 0-1.6 1Z" />
          </svg>
        </button>
      </div>
    </aside>
  );
}
