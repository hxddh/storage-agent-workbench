import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { useI18n, type Lang } from "../i18n";
import { localDayKey, previousDayKey, timeAgo } from "../lib/time";
import { useSessionRun, useSessionRunIndexVersion } from "../sessionRuns";
import { NAV_DAY_LABELS, useNavigationCopy } from "./navigationCopy";
import {
  DEFAULT_TASK_NAV_WIDTH,
  clampTaskNavigationWidth,
  type AgentTaskSummary,
  type TaskActions,
  type TaskEditRequest,
} from "./navigationModel";
import { agentTaskState } from "./taskState";
import { Icon } from "../components/icons";

// v1.14 — relative time and day keys live in lib/time (shared with the
// Artifacts panel and Execution detail); this module keeps the grouping.

export type TaskDayGroup = { key: string; label: string; tasks: AgentTaskSummary[] };

/**
 * The list is chronological and grouped by the day each task was last
 * touched: Today, Yesterday, then one dated header per earlier day. Groups
 * keep the newest-first order, so keyboard navigation can still flatten them.
 */
export function dayGroups(tasks: AgentTaskSummary[], lang: Lang, now: Date = new Date()): TaskDayGroup[] {
  const today = localDayKey(now.getTime());
  const yesterday = previousDayKey(today);
  const fmt = new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : "en-US", { month: "long", day: "numeric" });
  const fmtYear = new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : "en-US", { year: "numeric", month: "long", day: "numeric" });
  const groups: TaskDayGroup[] = [];
  for (const task of tasks) {
    const ms = Date.parse(task.updated_at);
    const day = Number.isNaN(ms) ? Number.NaN : localDayKey(ms);
    let key: string;
    let label: string;
    // v1.16 — day labels come from navigation copy, not inline ternaries.
    const dayLabels = NAV_DAY_LABELS[lang] ?? NAV_DAY_LABELS.en;
    if (Number.isNaN(day)) { key = "undated"; label = dayLabels.earlier; }
    else if (day >= today) { key = "today"; label = dayLabels.today; }
    else if (day >= yesterday) { key = "yesterday"; label = dayLabels.yesterday; }
    else {
      key = String(day);
      label = (new Date(day).getFullYear() === now.getFullYear() ? fmt : fmtYear).format(day);
    }
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.tasks.push(task);
    else groups.push({ key, label, tasks: [task] });
  }
  return groups;
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
          maxLength={120}
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
      title={[title, stateLabel, timeAgo(task.updated_at, t)].filter(Boolean).join(" — ")}
      aria-label={[title, stateLabel, timeAgo(task.updated_at, t)].filter(Boolean).join(", ")}
    >
      <div className="native-task-title">
        <span className="native-task-mark" aria-hidden />
        <strong>{title}</strong>
      </div>
      <span className="native-task-meta" aria-hidden>{timeAgo(task.updated_at, t)}</span>
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
  /** Opens the command palette — Codex Search lives on the left, not in the title bar. */
  onSearch: () => void;
  onOpenSettings: () => void;
  actions: TaskActions;
  /** Rename / Delete requested from outside the sidebar (native menu). */
  editRequest?: TaskEditRequest | null;
};

/** The sidebar: window chrome row, New task, Search, one chronological task list, Settings. */
export function AgentTaskNavigation({ tasks, activeTaskId, onSelectTask, onNew, onSearch, onOpenSettings, actions, editRequest = null, width, collapsed, trafficLights, onToggleCollapse, onResize }: AgentTaskNavigationProps) {
  const copy = useNavigationCopy();
  const { lang } = useI18n();
  useSessionRunIndexVersion();
  const [menuId, setMenuId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const listRef = useRef<HTMLElement>(null);
  // v1.14 — relative times go stale on an idle window; re-render them
  // minutely (times only, never the list order).
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((n) => n + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const visible = tasks.filter((task) => task.status !== "archived");
  visible.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  const groups = dayGroups(visible, lang);

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

  // v1.14 — a zero-width sidebar keeps no tab stops: width alone hides
  // sighted content while keyboard focus would still land inside it.
  return (
    <aside
      data-testid="agent-task-navigation"
      data-navigation="agent-tasks"
      data-collapsed={collapsed ? "true" : "false"}
      aria-label={copy.tasks}
      aria-hidden={collapsed ? true : undefined}
      inert={collapsed ? true : undefined}
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

        <div className="native-sidebar-actions">
          <button type="button" onClick={onNew} className="native-sidebar-new" data-testid="task-navigation-new">
            <Icon name="compose" />
            <span>{copy.newTask}</span>
          </button>
          <button type="button" onClick={onSearch} className="native-sidebar-new" data-testid="task-navigation-search" title={`${copy.search} ⌘K`}>
            <Icon name="search" />
            <span>{copy.search}</span>
          </button>
        </div>

        <nav ref={listRef} className="native-task-list" aria-label={copy.tasks} role="listbox" onKeyDown={onListKeyDown}>
          {visible.length === 0 ? (
            <p className="native-empty-list" data-testid="task-nav-empty">{copy.noTasks} {copy.noTasksHint}</p>
          ) : (
            groups.map((group) => (
              <div key={group.key} className="native-task-group" role="group" aria-label={group.label} data-testid="task-group" data-group={group.key}>
                <div className="native-sidebar-section" aria-hidden>{group.label}</div>
                {group.tasks.map((task) => (
                  <TaskRow key={task.id} task={task} activeTaskId={activeTaskId} menuId={menuId} renamingId={renamingId} confirmId={confirmId} onSelectTask={onSelectTask} setMenuId={setMenuId} setRenamingId={setRenamingId} setConfirmId={setConfirmId} actions={actions} />
                ))}
              </div>
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
