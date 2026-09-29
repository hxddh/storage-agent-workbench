import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api } from "../api";
import type { TaskRow } from "../api/types";
import { Icon } from "../components/icons";
import { IconButton, Kbd, StatusDot } from "../components/ui";
import { notifyNative } from "../hooks/useNativeAgent";
import { useI18n } from "../i18n";
import { useDismiss } from "../lib/useDismiss";
import { localDayKey, previousDayKey } from "../lib/time";
import { useTaskList } from "../store/tasks";
import { useApp } from "./context";

/**
 * The sidebar: New task (the home is a new conversation), an in-place title
 * search, one chronological list grouped by day, Settings. State is a mark on the row; Ready paints
 * nothing. ↑/↓ move between tasks.
 */
export function Sidebar() {
  const { t } = useI18n();
  const app = useApp();
  const [query, setQuery] = useState("");
  const { tasks, online } = useTaskList(query.trim());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const menuRef = useDismiss<HTMLLIElement>(menu !== null, () => setMenu(null));
  const listRef = useRef<HTMLDivElement>(null);
  const activeId = app.route.kind === "task" ? app.route.id : null;

  useEffect(() => app.setOnline(online), [online]); // eslint-disable-line react-hooks/exhaustive-deps

  // A task the watch opened while this window was open is worth one OS notification.
  const known = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!tasks || query) return;
    if (known.current) {
      for (const task of tasks) {
        if (!known.current.has(task.id) && task.origin === "watch") void notifyNative(t("watch.found", { name: task.title }), "");
      }
    }
    known.current = new Set(tasks.map((x) => x.id));
  }, [tasks, query, t]);

  const groups = useMemo(() => group(tasks ?? []), [tasks]);
  const flat = groups.flatMap((g) => g.tasks);

  const onListKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    // Only a task row moves the selection — never a rename field or a row's menu.
    if (!(e.target as HTMLElement).closest(".sidebar-task")) return;
    e.preventDefault();
    const at = flat.findIndex((x) => x.id === activeId);
    const next = flat[Math.max(0, Math.min(flat.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))];
    if (next) {
      app.openTask(next.id);
      listRef.current?.querySelector<HTMLElement>(`[data-task="${next.id}"]`)?.focus();
    }
  };

  const remove = async (task: TaskRow) => {
    setMenu(null);
    if (!window.confirm(t("nav.deleteConfirm", { title: task.title }))) return;
    await api.deleteTask(task.id);
    if (activeId === task.id) app.goHome();
  };

  return (
    <nav className="sidebar" aria-label={t("nav.tasks")} inert={!app.sidebar} data-open={app.sidebar ? "true" : "false"}>
      <div className="sidebar-chrome" data-tauri-drag-region>
        <IconButton icon="sidebar" label={t("nav.hideSidebar")} onClick={() => app.setSidebar(false)} />
      </div>
      <div className="sidebar-top">
        <button type="button" className="sidebar-new" data-active={app.route.kind === "home" ? "true" : undefined}
          onClick={() => app.goHome()} data-testid="new-task">
          <Icon name="compose" size={16} />
          <span>{t("nav.newTask")}</span>
          <Kbd keys={["Mod", "N"]} />
        </button>
        <label className="sidebar-search">
          <Icon name="search" size={14} />
          <input
            type="search"
            data-testid="task-search"
            data-focus-ring="container"
            value={query}
            placeholder={t("nav.search")}
            aria-label={t("nav.search")}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setQuery(""); }}
          />
        </label>
      </div>
      <div className="sidebar-list" ref={listRef} onKeyDown={onListKey} data-testid="task-list">
        {tasks && flat.length === 0 ? (
          <p className="sidebar-empty">{query ? t("nav.noMatch") : t("nav.empty")}</p>
        ) : null}
        {groups.map((g) => (
          <section key={g.label} aria-label={t(g.label)}>
            <h2 className="sidebar-day">{t(g.label)}</h2>
            <ul>
              {g.tasks.map((task) => (
                <li key={task.id} className="sidebar-row" ref={menu === task.id ? menuRef : undefined}
                  data-active={task.id === activeId ? "true" : undefined}>
                  {renaming === task.id ? (
                    <RenameField task={task} onDone={() => setRenaming(null)} />
                  ) : (
                    <button
                      type="button"
                      className="sidebar-task"
                      data-task={task.id}
                      data-state={task.state}
                      aria-current={task.id === activeId ? "page" : undefined}
                      onClick={() => app.openTask(task.id)}
                      onDoubleClick={() => setRenaming(task.id)}
                    >
                      <span className="sidebar-task-title">{task.title}</span>
                      <StateMark task={task} />
                    </button>
                  )}
                  <IconButton icon="more" label={t("nav.more")} className="sidebar-more" aria-haspopup="menu"
                    aria-expanded={menu === task.id} onClick={() => setMenu(menu === task.id ? null : task.id)} />
                  {menu === task.id ? (
                    <div className="ui-menu sidebar-menu" role="menu" onKeyDown={(e) => e.key === "Escape" && setMenu(null)}>
                      <button type="button" role="menuitem" className="ui-menu-item" autoFocus
                        onClick={() => { setMenu(null); setRenaming(task.id); }}>{t("nav.rename")}</button>
                      <button type="button" role="menuitem" className="ui-menu-item" data-danger="true"
                        onClick={() => void remove(task)}>{t("nav.delete")}</button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <div className="sidebar-foot">
        <button type="button" className="sidebar-link" onClick={() => app.openSettings()} data-testid="open-settings">
          <Icon name="settings" size={16} />
          <span>{t("nav.settings")}</span>
        </button>
        {!online ? (
          <span className="sidebar-offline"><StatusDot tone="danger" />{t("nav.offline")}</span>
        ) : null}
      </div>
    </nav>
  );
}

function StateMark({ task }: { task: TaskRow }) {
  const { t } = useI18n();
  if (task.state === "working") return <span className="sidebar-mark" title={t("state.working")}><StatusDot tone="accent" pulse /></span>;
  if (task.state === "queued") return <span className="sidebar-mark" title={t("state.queued")}><StatusDot tone="neutral" /></span>;
  if (task.state === "needs_attention") {
    return <span className="sidebar-mark" title={t("state.needs_attention")}><StatusDot tone="warn" /></span>;
  }
  if (task.origin === "watch") return <span className="sidebar-mark" title={t("nav.watch")}><Icon name="shield" size={14} /></span>;
  return null;
}

function RenameField({ task, onDone }: { task: TaskRow; onDone: () => void }) {
  const [value, setValue] = useState(task.title);
  const save = async () => {
    const title = value.trim();
    if (title && title !== task.title) await api.renameTask(task.id, title.slice(0, 120));
    onDone();
  };
  return (
    <input
      className="ui-input sidebar-rename"
      value={value}
      maxLength={120}
      autoFocus
      onFocus={(e) => e.target.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => void save()}
      onKeyDown={(e) => {
        if (e.key === "Enter") void save();
        if (e.key === "Escape") onDone();
      }}
    />
  );
}

export function group(tasks: TaskRow[]): Array<{ label: string; tasks: TaskRow[] }> {
  const today = localDayKey(Date.now());
  const yesterday = previousDayKey(today);
  const out = { "nav.today": [] as TaskRow[], "nav.yesterday": [] as TaskRow[], "nav.earlier": [] as TaskRow[] };
  for (const task of tasks) {
    const key = localDayKey(Date.parse(task.updated_at));
    (key === today ? out["nav.today"] : key === yesterday ? out["nav.yesterday"] : out["nav.earlier"]).push(task);
  }
  return Object.entries(out).filter(([, list]) => list.length).map(([label, list]) => ({ label, tasks: list }));
}
