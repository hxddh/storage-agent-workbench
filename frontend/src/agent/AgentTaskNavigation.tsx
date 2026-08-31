import { useEffect, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { useI18n, type TFunc } from "../i18n";
import { useSessionRun, useSessionRunIndexVersion } from "../sessionRuns";
import { EmptyState } from "../components/EmptyState";
import { MOD } from "../shortcuts";
import { useNavigationCopy } from "./navigationCopy";
import {
  DEFAULT_TASK_NAV_WIDTH,
  clampTaskNavigationWidth,
  type AgentTaskSummary,
  type TaskActions,
} from "./navigationModel";
import { agentTaskState } from "./taskState";

const PlusIcon = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>;
const SettingsIcon = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21h-4v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H3v-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3h4a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9A1.7 1.7 0 0 0 21 10h.1v4H21a1.7 1.7 0 0 0-1.6 1Z" /></svg>;
const SidebarIcon = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden><rect x="3" y="4" width="18" height="16" rx="2" /><line x1="9" y1="4" x2="9" y2="20" /></svg>;
const MoreIcon = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>;

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

function MenuItem({ children, onClick, danger = false }: { children: ReactNode; onClick: (event: MouseEvent<HTMLButtonElement>) => void; danger?: boolean }) {
  return <button type="button" onClick={onClick} className={`block w-full px-3 py-1.5 text-left text-xs transition-colors ${danger ? "text-danger hover:bg-danger-bg" : "text-gray-300 hover:bg-hover hover:text-gray-100"}`}>{children}</button>;
}

function TaskRow({ task, activeTaskId, menuId, renamingId, confirmId, onSelectTask, setMenuId, setRenamingId, setConfirmId, actions }: {
  task: AgentTaskSummary;
  activeTaskId: string | null;
  menuId: string | null;
  renamingId: string | null;
  confirmId: string | null;
  onSelectTask: (id: string) => void;
  setMenuId: (id: string | null) => void;
  setRenamingId: (id: string | null) => void;
  setConfirmId: (id: string | null) => void;
  actions: TaskActions;
}) {
  const { t } = useI18n();
  const copy = useNavigationCopy();
  const run = useSessionRun(task.id);
  const selected = task.id === activeTaskId;
  const menuOpen = menuId === task.id;
  const renaming = renamingId === task.id;
  const confirming = confirmId === task.id;
  const [renameValue, setRenameValue] = useState(task.title || "");
  const renameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!renaming) return;
    setRenameValue(task.title || "");
    requestAnimationFrame(() => { renameRef.current?.focus(); renameRef.current?.select(); });
  }, [renaming, task.title]);

  const stateKey = agentTaskState(run, true, task.requires_decision, task.task_status);
  const act = (fn: () => void) => (event: MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); setMenuId(null); fn(); };

  if (renaming) {
    return (
      <div className="agent-task-row agent-task-row-renaming" data-testid="task-row-rename">
        <input ref={renameRef} value={renameValue} onChange={(event) => setRenameValue(event.target.value)} onBlur={() => { setRenamingId(null); const title = renameValue.trim(); if (title && title !== task.title) actions.onRename(task, title); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") setRenamingId(null); }} className="w-full rounded-md border border-accent/50 bg-elevated px-2 py-1.5 text-xs text-gray-100 outline-none" />
      </div>
    );
  }

  return (
    <div className="agent-task-row group" data-testid="task-row" data-selected={selected ? "true" : "false"} data-state={stateKey} onClick={() => onSelectTask(task.id)} title={`${task.title || t("common.untitled")} — ${relTime(task.updated_at, t)}`}>
      <span className="agent-task-state-mark" aria-hidden />
      <div className="agent-task-row-content">
        <div className="agent-task-row-title">
          <strong>{task.title || t("common.untitled")}</strong>
        </div>
      </div>
      <button type="button" aria-label={t("menu.more")} onClick={(event) => { event.stopPropagation(); setConfirmId(null); setMenuId(menuOpen ? null : task.id); }} className="agent-task-more"><MoreIcon /></button>

      {menuOpen ? (
        <div className="agent-task-menu">
          <MenuItem onClick={act(() => setRenamingId(task.id))}>{t("menu.rename")}</MenuItem>
          <div className="my-1 border-t border-edge" />
          <MenuItem danger onClick={act(() => setConfirmId(task.id))}>{t("menu.delete")}</MenuItem>
        </div>
      ) : null}

      {confirming ? (
        <div className="agent-task-confirm" onClick={(event) => event.stopPropagation()}>
          <div>{copy.deleteConfirm}</div>
          <div className="mt-2 flex justify-end gap-1.5">
            <button type="button" onClick={(event) => { event.stopPropagation(); setConfirmId(null); }} className="rounded-md px-2.5 py-1 text-xs text-gray-300 hover:bg-hover">{copy.cancel}</button>
            <button type="button" onClick={(event) => { event.stopPropagation(); setConfirmId(null); actions.onDelete(task); }} className="rounded-md bg-danger px-2.5 py-1 text-xs font-medium text-white">{copy.delete}</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export type AgentTaskNavigationProps = {
  width: number;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onResize: (px: number) => void;
  tasks: AgentTaskSummary[];
  activeTaskId: string | null;
  onSelectTask: (id: string) => void;
  onNew: () => void;
  onOpenSettings: () => void;
  actions: TaskActions;
};

export function AgentTaskNavigation({ tasks, activeTaskId, onSelectTask, onNew, onOpenSettings, actions, width, collapsed, onToggleCollapse, onResize }: AgentTaskNavigationProps) {
  const copy = useNavigationCopy();
  useSessionRunIndexVersion();
  const [menuId, setMenuId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const visible = tasks.filter((task) => task.status !== "archived");
  visible.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));

  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const move = (next: globalThis.PointerEvent) => onResize(clampTaskNavigationWidth(next.clientX));
    const stop = () => { handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", stop); handle.removeEventListener("pointercancel", stop); };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  };

  const row = (task: AgentTaskSummary) => <TaskRow key={task.id} task={task} activeTaskId={activeTaskId} menuId={menuId} renamingId={renamingId} confirmId={confirmId} onSelectTask={onSelectTask} setMenuId={setMenuId} setRenamingId={setRenamingId} setConfirmId={setConfirmId} actions={actions} />;

  if (collapsed) {
    return (
      <aside data-testid="agent-task-navigation" data-navigation="agent-tasks" data-collapsed="true" aria-label={copy.tasks} className="agent-task-nav-collapsed">
        <button type="button" onClick={onToggleCollapse} title={copy.expand} aria-label={copy.expand} data-testid="task-navigation-toggle" className="agent-task-nav-icon"><SidebarIcon /></button>
        <button type="button" onClick={onNew} title={copy.newTask} aria-label={copy.newTask} className="agent-task-nav-icon"><PlusIcon /></button>
        <div className="mt-auto flex flex-col items-center gap-2">
          <button type="button" onClick={onOpenSettings} aria-label={copy.settings} className="agent-task-nav-icon"><SettingsIcon /></button>
        </div>
      </aside>
    );
  }

  return (
    <aside data-testid="agent-task-navigation" data-navigation="agent-tasks" data-collapsed="false" aria-label={copy.tasks} style={{ width }} className="agent-task-nav">
      <div onPointerDown={startResize} onDoubleClick={() => onResize(DEFAULT_TASK_NAV_WIDTH)} role="separator" aria-orientation="vertical" aria-label={copy.resize} data-testid="task-navigation-resize" className="agent-task-nav-resize" />
      {(menuId || confirmId) ? <div className="fixed inset-0 z-sticky" onClick={() => { setMenuId(null); setConfirmId(null); }} /> : null}

      <header className="agent-task-nav-header">
        <button type="button" onClick={onNew} className="agent-task-new" data-testid="task-navigation-new">
          <span className="agent-task-new-mark"><PlusIcon /></span>
          <span>{copy.newTask}</span>
          <kbd>{MOD}N</kbd>
        </button>
        <button type="button" onClick={onToggleCollapse} aria-label={copy.collapse} title={copy.collapse} data-testid="task-navigation-toggle" className="agent-task-nav-collapse"><SidebarIcon /></button>
      </header>

      <nav className="agent-task-list" aria-label={copy.tasks}>
        {visible.length === 0 ? (
          <EmptyState compact testId="task-nav-empty" title={copy.noTasks} body={copy.noTasksHint} />
        ) : (
          <section className="agent-task-queue">{visible.map(row)}</section>
        )}
      </nav>

      <footer className="agent-task-nav-footer">
        <button type="button" onClick={onOpenSettings} aria-label={copy.settings} data-testid="task-navigation-settings"><SettingsIcon /></button>
      </footer>
    </aside>
  );
}
