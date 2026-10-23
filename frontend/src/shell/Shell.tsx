import { useCallback, useEffect, useRef } from "react";
import { api } from "../api";
import { Composer } from "../composer/Composer";
import { hasNativeTrafficLights, openExternal } from "../config";
import { Icon } from "../components/icons";
import { IconButton } from "../components/ui";
import { notifyNative, setNativeWindowTitle, useNativeShell, type MenuCommand } from "../hooks/useNativeAgent";
import { useI18n } from "../i18n";
import { Details } from "../inspector/Inspector";
import { Settings } from "../settings/Settings";
import { useTask } from "../store/task";
import { TaskPage } from "../task/TaskPage";
import { useTheme } from "../theme";
import { useApp } from "./context";
import { Sidebar } from "./Sidebar";

/**
 * The one window: sidebar · title bar · one document · one Composer (home or
 * Task), plus the closable Evidence pane for a Task.
 */
export function Shell() {
  const app = useApp();
  const taskId = app.route.kind === "task" ? app.route.id : null;
  const { model, setSnapshot, reload, loadOlder } = useTask(taskId);
  const busy = model.state === "working" || model.state === "queued";
  const { t } = useI18n();
  const theme = useTheme();
  const prevState = useRef(model.state);

  // An OS notification when a task this window follows settles in the background.
  useEffect(() => {
    const was = prevState.current;
    prevState.current = model.state;
    if (was === "working" && model.state !== "working" && document.hidden && model.snapshot) {
      const title = model.snapshot.task.title;
      void notifyNative(model.state === "needs_attention" ? t("notify.attention", { title }) : t("notify.done", { title }), "");
    }
  }, [model.state, model.snapshot, t]);

  useEffect(() => {
    void setNativeWindowTitle(model.snapshot && taskId ? `${model.snapshot.task.title} — Storage Agent` : "Storage Agent");
  }, [model.snapshot, taskId]);

  // Evidence belongs to a task: leaving it closes the pane.
  useEffect(() => { if (!taskId && app.pane) app.setPane(null); }, [taskId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Liveness is not inferred from whichever call happened last: a sidecar that
  // restarted under the window comes back without a reload. A slow poll keeps
  // the offline mark honest and reloads the task when it returns.
  const wasOnline = useRef(app.online);
  useEffect(() => { if (!app.online) wasOnline.current = false; }, [app.online]);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        await api.health();
        if (stop) return;
        app.setOnline(true);
        if (!wasOnline.current) { await app.reloadProviders(); void reload(); }
        wasOnline.current = true;
      } catch {
        if (stop) return;
        app.setOnline(false);
        wasOnline.current = false;
      }
    };
    const timer = window.setInterval(() => void tick(), 8_000);
    return () => { stop = true; window.clearInterval(timer); };
  }, [app, reload]);

  const command = useCallback((c: MenuCommand) => {
    switch (c) {
      case "new-task": app.goHome(); break;
      case "settings": app.openSettings(); break;
      case "search": {
        if (!app.sidebar) app.setSidebar(true);
        requestAnimationFrame(() => document.querySelector<HTMLInputElement>("[data-testid=task-search]")?.focus());
        break;
      }
      case "toggle-sidebar": app.setSidebar(!app.sidebar); break;
      case "theme": theme.toggle(); break;
      case "stop": if (taskId) void api.stop(taskId); break;
      case "review": if (taskId) app.setPane(app.pane?.tab === "details" ? null : { tab: "details" }); break; // Evidence shows; pressing again closes it
      case "focus-composer": document.querySelector<HTMLTextAreaElement>("[data-testid=composer-input]")?.focus(); break;
      case "release-notes": void openExternal("https://github.com/hxddh/storage-agent-workbench/releases"); break;
      case "rename-task": {
        const current = model.snapshot?.task.title;
        const next = taskId && current != null ? window.prompt(t("nav.rename"), current) : null;
        if (taskId && next && next.trim()) void api.renameTask(taskId, next.trim().slice(0, 120)).then(() => reload());
        break;
      }
      case "delete-task":
        if (taskId && window.confirm(t("nav.deleteConfirm", { title: model.snapshot?.task.title ?? "" }))) {
          void api.deleteTask(taskId).then(() => app.goHome());
        }
        break;
      case "resume": {
        const last = model.turns[model.turns.length - 1];
        if (taskId && last && (last.status === "interrupted" || last.status === "failed")) void api.resume(taskId, last.id);
        break;
      }
      default: break;
    }
  }, [app, theme, taskId, model, reload, t]);

  useNativeShell({ onOpenTask: app.openTask, onMenuCommand: command, onSummon: () => command("focus-composer") });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === "k") { e.preventDefault(); command("search"); }
      else if (k === "n" && !e.shiftKey) { e.preventDefault(); command("new-task"); }
      else if (k === ",") { e.preventDefault(); command("settings"); }
      else if (k === "i" && taskId) { e.preventDefault(); command("review"); }
      else if (k === "b" || k === "\\") { e.preventDefault(); command("toggle-sidebar"); }
      else if (k === "." && busy) { e.preventDefault(); command("stop"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [app, command, taskId, busy]);

  const title = taskId ? model.snapshot?.task.title ?? "" : "";

  return (
    <div className="window" data-traffic-lights={hasNativeTrafficLights() ? "true" : undefined} data-sidebar={app.sidebar ? "open" : "closed"} data-pane={app.pane ? "open" : "closed"}>
      <Sidebar />
      {/* Narrow window only (CSS): tapping outside the overlaid sidebar closes it. */}
      {app.sidebar ? <div className="scrim" aria-hidden onClick={() => app.setSidebar(false)} /> : null}
      <main className="main" aria-busy={busy} data-home={!taskId ? "true" : undefined}>
        <header className="titlebar" data-tauri-drag-region>
          <div className="titlebar-start">
            {!app.sidebar ? (
              <>
                <IconButton icon="sidebar" label={t("nav.showSidebar")} data-testid="show-sidebar" onClick={() => app.setSidebar(true)} />
                {taskId ? <IconButton icon="compose" label={t("nav.newTask")} onClick={() => app.goHome()} /> : null}
              </>
            ) : null}
          </div>
          <div className="titlebar-center" data-tauri-drag-region>
            {!app.sidebar && title ? <span className="titlebar-title" data-testid="task-title">{title}</span> : null}
          </div>
          <div className="titlebar-end">
            {taskId ? (
              <button type="button" className="titlebar-action" data-testid="titlebar-sidepane"
                aria-pressed={!!app.pane} onClick={() => command("review")}>
                <Icon name="panelRight" size={15} />
                <span>{app.pane ? t("pane.close") : t("pane.open")}</span>
              </button>
            ) : null}
          </div>
        </header>
        {/* A scrolling page is not a Tab stop of its own (the keys still scroll it once focus is inside). */}
        <div className="document" data-testid="document" tabIndex={-1}>
          {taskId ? <TaskPage key={taskId} model={model} setSnapshot={setSnapshot} onRetry={reload} onLoadOlder={loadOlder} /> : null}
        </div>
        {/* One Composer, one mount. Home is the same component in the centre of
            an empty conversation; a task docks it at the foot. */}
        <div className={taskId ? "dock" : "home-dock"} data-testid={taskId ? undefined : "home"}>
          {!taskId ? (
            <div className="home-head">
              <span className="empty-mark" aria-hidden><Icon name="agent" size={19} /></span>
              <h1 className="empty-greeting">{t("home.greeting")}</h1>
            </div>
          ) : null}
          <Composer taskId={taskId} busy={busy} onCreated={app.openTask} autoFocus={!taskId} />
        </div>
      </main>
      {taskId && app.pane ? <Details model={model} /> : null}
      {app.settings ? <Settings /> : null}
      {/* State is painted once (sidebar), and announced once for screen readers. */}
      <span className="sr-only" aria-live="polite">{taskId ? t(`state.${model.state}`) : ""}</span>
    </div>
  );
}
