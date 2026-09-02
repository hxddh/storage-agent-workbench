import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { useI18n, type TFunc } from "../i18n";
import { useSessionRun, useSessionRunIndexVersion } from "../sessionRuns";
import { useNavigationCopy } from "./navigationCopy";
import {
  DEFAULT_TASK_NAV_WIDTH,
  clampTaskNavigationWidth,
  type AgentTaskSummary,
  type TaskActions,
  type TaskEditRequest,
} from "./navigationModel";
import { agentTaskState } from "./taskState";
import { Icon } from "../components/icons";

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
  const stateLabel = stateKey in copy.state ? copy.state[stateKey as keyof typeof copy.state] : "";
  const act = (fn: () => void) => (event: MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); setMenuId(null); fn(); };

  if (renaming) {
    return (
      <div className="native-task-rename" data-testid="task-row-rename">
        <input
          ref={renameRef}
          value={renameValue}
          onChange={(event) => setRenameValue(event.target.value)}
          onBlur={() => { setRenamingId(null); const title = renameValue.trim(); if (title && title !== task.title) actions.onRename(task, title); }}
          onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") setRenamingId(null); }}
        />
      </div>
    );
  }

  const title = task.title || t("common.untitled");
  return (
    <div
      className="native-task-row"
      data-testid="task-row"
      data-selected={selected ? "true" : "false"}
      data-state={stateKey}
      data-menu-open={menuOpen || confirming ? "true" : "false"}
      onClick={() => onSelectTask(task.id)}
      role="option"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelectTask(task.id); } }}
      title={stateLabel ? `${title} — ${stateLabel}` : title}
    >
      <div className="native-task-title">
        <span className="native-task-mark" aria-hidden />
        <strong>{title}</strong>
      </div>
      <span className="native-task-meta" aria-hidden>{relTime(task.updated_at, t)}</span>
      <button
        type="button"
        aria-label={t("menu.more")}
        onClick={(event) => { event.stopPropagation(); setConfirmId(null); setMenuId(menuOpen ? null : task.id); }}
        className="native-task-more"
      >
        <Icon name="more" size={14} />
      </button>

      {menuOpen ? (
        <div className="native-menu">
          <button type="button" onClick={act(() => setRenamingId(task.id))}>{t("menu.rename")}</button>
          <button type="button" data-danger="true" onClick={act(() => setConfirmId(task.id))}>{t("menu.delete")}</button>
        </div>
      ) : null}

      {confirming ? (
        <div className="native-confirm" onClick={(event) => event.stopPropagation()}>
          <div>{copy.deleteConfirm}</div>
          <div className="mt-2 flex justify-end gap-1.5">
            <button type="button" onClick={(event) => { event.stopPropagation(); setConfirmId(null); }} className="rounded-md px-2.5 py-1 text-xs text-gray-300 hover:bg-hover hover:text-gray-100">{copy.cancel}</button>
            <button type="button" onClick={(event) => { event.stopPropagation(); setConfirmId(null); actions.onDelete(task); }} className="rounded-md bg-danger px-2.5 py-1 text-xs font-medium text-accent-fg">{copy.delete}</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export type AgentTaskNavigationProps = {
  width: number;
  collapsed: boolean;
  trafficLights: boolean;
  onToggleCollapse: () => void;
  onResize: (px: number) => void;
  tasks: AgentTaskSummary[];
  activeTaskId: string | null;
  onSelectTask: (id: string) => void;
  onNew: () => void;
  onOpenSettings: () => void;
  actions: TaskActions;
  /** Rename / Delete requested from outside the sidebar (native menu). */
  editRequest?: TaskEditRequest | null;
};

/** The sidebar: window chrome row, New task, one chronological task list, Settings. */
export function AgentTaskNavigation({ tasks, activeTaskId, onSelectTask, onNew, onOpenSettings, actions, editRequest = null, width, collapsed, trafficLights, onToggleCollapse, onResize }: AgentTaskNavigationProps) {
  const copy = useNavigationCopy();
  useSessionRunIndexVersion();
  const [menuId, setMenuId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const listRef = useRef<HTMLElement>(null);

  const visible = tasks.filter((task) => task.status !== "archived");
  visible.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));

  // The native menu's Task → Rename / Delete land here, on the same inline
  // controls the More menu opens; there is no second edit path.
  useEffect(() => {
    if (!editRequest) return;
    setMenuId(null);
    if (editRequest.kind === "rename") { setConfirmId(null); setRenamingId(editRequest.id); }
    else { setRenamingId(null); setConfirmId(editRequest.id); }
  }, [editRequest]);

  // ↑ / ↓ move between tasks while the list has focus; Enter / Space open one.
  const onListKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (renamingId || visible.length === 0) return;
    event.preventDefault();
    const index = visible.findIndex((task) => task.id === activeTaskId);
    const next = event.key === "ArrowDown"
      ? Math.min(visible.length - 1, index + 1)
      : Math.max(0, index <= 0 ? 0 : index - 1);
    const target = visible[next];
    if (!target || target.id === activeTaskId) return;
    onSelectTask(target.id);
    requestAnimationFrame(() => {
      const rows = listRef.current?.querySelectorAll<HTMLElement>('[data-testid="task-row"]');
      rows?.[next]?.focus();
    });
  };

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

  return (
    <aside
      data-testid="agent-task-navigation"
      data-navigation="agent-tasks"
      data-collapsed={collapsed ? "true" : "false"}
      aria-label={copy.tasks}
      aria-hidden={collapsed ? true : undefined}
      style={{ width, minWidth: width }}
      className="native-sidebar"
    >
      <div className="native-sidebar-inner" style={{ width }}>
        {!collapsed ? (
          <div onPointerDown={startResize} onDoubleClick={() => onResize(DEFAULT_TASK_NAV_WIDTH)} role="separator" aria-orientation="vertical" aria-label={copy.resize} data-testid="task-navigation-resize" className="native-sidebar-resize" />
        ) : null}
        {(menuId || confirmId) ? <div className="fixed inset-0 z-sticky" onClick={() => { setMenuId(null); setConfirmId(null); }} /> : null}

        <div className="native-chrome" data-traffic-lights={trafficLights ? "true" : "false"} data-tauri-drag-region>
          <span className="flex-1" data-tauri-drag-region />
          {!collapsed ? (
            <button type="button" onClick={onToggleCollapse} aria-label={copy.collapse} title={copy.collapse} data-testid="task-navigation-toggle" className="native-icon-button">
              <Icon name="sidebar" />
            </button>
          ) : null}
        </div>

        <button type="button" onClick={onNew} className="native-sidebar-new" data-testid="task-navigation-new">
          <Icon name="compose" />
          <span>{copy.newTask}</span>
        </button>

        <div className="native-sidebar-section">{copy.tasks}</div>
        <nav ref={listRef} className="native-task-list" aria-label={copy.tasks} role="listbox" onKeyDown={onListKeyDown}>
          {visible.length === 0 ? (
            <p className="native-empty-list" data-testid="task-nav-empty">{copy.noTasks} {copy.noTasksHint}</p>
          ) : (
            visible.map((task) => (
              <TaskRow key={task.id} task={task} activeTaskId={activeTaskId} menuId={menuId} renamingId={renamingId} confirmId={confirmId} onSelectTask={onSelectTask} setMenuId={setMenuId} setRenamingId={setRenamingId} setConfirmId={setConfirmId} actions={actions} />
            ))
          )}
        </nav>

        <footer className="native-sidebar-footer">
          <button type="button" onClick={onOpenSettings} aria-label={copy.settings} data-testid="task-navigation-settings" className="native-sidebar-settings">
            <Icon name="settings" />
            <span>{copy.settings}</span>
          </button>
        </footer>
      </div>
    </aside>
  );
}
