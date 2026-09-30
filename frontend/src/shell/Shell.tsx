import { useCallback, useEffect, useRef } from "react";
import { api } from "../api";
import { Composer } from "../composer/Composer";
import { hasNativeTrafficLights, openExternal } from "../config";
import { IconButton, StatusDot } from "../components/ui";
import { BucketSheet } from "../estate/BucketSheet";
import { Home } from "../home/Home";
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
 * The window: sidebar · title bar · one document (the home or one Task) ·
 * one Composer, plus the closable side pane for the Task's outputs.
 */
export function Shell() {
  const app = useApp();
  const taskId = app.route.kind === "task" ? app.route.id : null;
  const { model, setSnapshot, reload } = useTask(taskId);
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

  // Details belong to a task: leaving it closes them (a bucket sheet stays open).
  useEffect(() => { if (!taskId && app.pane?.tab === "details") app.setPane(null); }, [taskId]); // eslint-disable-line react-hooks/exhaustive-deps

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
      case "review": if (taskId) app.setPane(app.pane ? null : { tab: "details" }); break; // the toggle closes whatever pane is open
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
  const state = taskId ? model.state : null;

  return (
    <div className="window" data-traffic-lights={hasNativeTrafficLights() ? "true" : undefined} data-sidebar={app.sidebar ? "open" : "closed"} data-pane={app.pane ? "open" : "closed"}>
      <Sidebar />
      {/* Narrow window only (CSS): tapping outside the overlaid sidebar closes it. */}
      {app.sidebar ? <div className="scrim" aria-hidden onClick={() => app.setSidebar(false)} /> : null}
      <main className="main" aria-busy={busy}>
        <header className="titlebar" data-tauri-drag-region>
          <div className="titlebar-start">
            {!app.sidebar ? (
              <>
                <IconButton icon="sidebar" label={t("nav.showSidebar")} onClick={() => app.setSidebar(true)} />
                <IconButton icon="compose" label={t("nav.newTask")} onClick={() => app.goHome()} />
              </>
            ) : null}
          </div>
          <div className="titlebar-center" data-tauri-drag-region>
            <span className="titlebar-title" data-testid="task-title">{title}</span>
            {state && state !== "ready" ? (
              <span className="state-pill" data-state={state} data-testid="task-state">
                <StatusDot tone={state === "working" ? "accent" : state === "needs_attention" ? "warn" : "neutral"} pulse={state === "working"} />
                {t(`state.${state}`)}
              </span>
            ) : null}
          </div>
          <div className="titlebar-end">
            {taskId ? (
              <IconButton icon="panelRight" label={app.pane ? t("pane.close") : t("pane.open")} data-testid="titlebar-sidepane"
                aria-pressed={!!app.pane} onClick={() => command("review")} />
            ) : null}
          </div>
          {busy ? <div className="titlebar-progress" aria-hidden /> : null}
        </header>
        {/* A scrolling page is not a Tab stop of its own (the keys still scroll it once focus is inside). */}
        <div className="document" data-testid="document" tabIndex={-1}>
          {taskId ? <TaskPage key={taskId} model={model} setSnapshot={setSnapshot} />
            : <Home />}
        </div>
        {taskId ? (
          <div className="dock">
            <Composer key={taskId} taskId={taskId} busy={busy} />
          </div>
        ) : null}
      </main>
      {taskId && app.pane?.tab === "details" ? <Details model={model} /> : null}
      {app.pane?.tab === "bucket" ? <BucketSheet key={`${app.pane.providerId}/${app.pane.bucket}`}
        providerId={app.pane.providerId} bucket={app.pane.bucket} /> : null}
      {app.settings ? <Settings /> : null}
      <span className="sr-only" aria-live="polite">{state ? t(`state.${state}`) : ""}</span>
    </div>
  );
}
