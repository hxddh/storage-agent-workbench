import { useCallback, useEffect, useRef, useState } from "react";
import { closeTopOverlay } from "./lib/overlayStack";
import { AgentTask } from "./components/AgentTask";
import { SettingsDialog } from "./components/SettingsDialog";
import { CommandPalette } from "./components/CommandPalette";
import { deleteSession, patchSession } from "./api";
import { dropSessionRun, getSessionRun, useSessionRun, useSessionRunIndexVersion } from "./sessionRuns";
import { useSidecarHealth } from "./hooks/useSidecarHealth";
import { useI18n } from "./i18n";
import { useTheme } from "./theme";
import { useToast } from "./components/Toast";
import { ShortcutsSheet } from "./components/ShortcutsSheet";
import { isEditable, matches } from "./shortcuts";
import { getPaletteActions, publishBasePaletteActions } from "./agent/paletteActions";
import { AgentTaskNavigation } from "./agent/AgentTaskNavigation";
import { useNavigationCopy } from "./agent/navigationCopy";
import { DEFAULT_TASK_NAV_WIDTH, clampTaskNavigationWidth, type AgentTaskSummary, type TaskActions, type TaskEditRequest } from "./agent/navigationModel";
import { AgentShell } from "./agent/AgentShell";
import { toggleAgentArtifacts } from "./agent/commands";
import { ActiveTaskContext } from "./agent/activeTask";
import { listAgentTasks } from "./agent/taskApi";
import { agentTaskState } from "./agent/taskState";
import { notifyNative, setNativeWindowTitle, useNativeShell, type MenuCommand } from "./hooks/useNativeAgent";
import { hasNativeTrafficLights, openExternal } from "./config";
import { Icon } from "./components/icons";

const NAV_WIDTH_KEY = "saw.railWidth";
const NAV_COLLAPSED_KEY = "saw.railCollapsed";
const ACTIVE_TASK_KEY = "saw.activeSession";
const NAV_FOLD_PX = 1080;
const RELEASE_NOTES_URL = "https://github.com/hxddh/storage-agent-workbench/releases";
// A menu accelerator and the window's own keydown handler can both fire for
// one keypress on some platforms; the second arrival inside this window is
// the same intent, not a second command.
const COMMAND_DEDUP_MS = 250;

function storedNavigationWidth(): number {
  const raw = Number(localStorage.getItem(NAV_WIDTH_KEY));
  return Number.isFinite(raw) && raw > 0 ? clampTaskNavigationWidth(raw) : DEFAULT_TASK_NAV_WIDTH;
}

/** Window title row over the document: the task name and its real state.
 * ⌘F opens the reading-column Find strip; ⌘K opens the palette. Search is
 * the quieter sidebar row under New task. Collapsed, the sidebar toggle
 * and New task move here. */
function TitleBar({ task, sidebarOpen, trafficLights, onToggleSidebar, onNew }: {
  task: AgentTaskSummary | null;
  sidebarOpen: boolean;
  trafficLights: boolean;
  onToggleSidebar: () => void;
  onNew: () => void;
}) {
  const copy = useNavigationCopy();
  const { t } = useI18n();
  const run = useSessionRun(task?.id ?? null);
  const state = task ? agentTaskState(run, true, task.requires_decision, task.task_status) : "idle";
  const stateLabel = state in copy.state ? copy.state[state as keyof typeof copy.state] : "";
  const title = task ? (task.title || t("common.untitled")) : copy.appTitle;

  useEffect(() => {
    void setNativeWindowTitle(task ? `${title} — ${copy.appTitle}` : copy.appTitle);
  }, [task, title, copy.appTitle]);

  return (
    <header className="native-titlebar" data-traffic-lights={trafficLights && !sidebarOpen ? "true" : "false"} data-tauri-drag-region>
      {!sidebarOpen ? (
        <>
          <button type="button" onClick={onToggleSidebar} aria-label={copy.expand} title={copy.expand} data-testid="task-navigation-toggle" className="native-icon-button">
            <Icon name="sidebar" />
          </button>
          <button type="button" onClick={onNew} aria-label={copy.newTask} title={copy.newTask} className="native-icon-button">
            <Icon name="compose" />
          </button>
        </>
      ) : null}
      <span className="native-titlebar-title" data-task={task ? "true" : "false"} data-tauri-drag-region>
        <span className="native-titlebar-name">{title}</span>
        {stateLabel ? (
          <span className="native-titlebar-state" data-state={state} data-testid="titlebar-state">
            {state === "working" || state === "uploading" ? <span className="working-mark" style={{ width: 6, height: 6 }} aria-hidden /> : null}
            {stateLabel}
          </span>
        ) : null}
      </span>
    </header>
  );
}

/**
 * One OS notification when a background Execution settles: the task is not
 * the one on screen, or the window is hidden. Driven by the run store the app
 * already follows — no polling, no second event path.
 */
function useSettleNotifications(tasks: AgentTaskSummary[], activeTaskId: string | null) {
  const version = useSessionRunIndexVersion();
  const copy = useNavigationCopy();
  const { t } = useI18n();
  const busyRef = useRef(new Map<string, boolean>());
  useEffect(() => {
    const seen = busyRef.current;
    for (const task of tasks) {
      const busy = getSessionRun(task.id).busy;
      const was = seen.get(task.id) ?? false;
      seen.set(task.id, busy);
      if (!was || busy) continue;
      const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
      if (task.id === activeTaskId && !hidden) continue;
      void notifyNative(task.title || t("common.untitled"), copy.notifySettled);
    }
  }, [version, tasks, activeTaskId, copy.notifySettled, t]);
}

export default function App() {
  const { status } = useSidecarHealth();
  const [tasks, setTasks] = useState<AgentTaskSummary[]>([]);
  const [activeTaskId, setActiveTaskIdState] = useState<string | null>(() => localStorage.getItem(ACTIVE_TASK_KEY));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [navigationWidth, setNavigationWidth] = useState(storedNavigationWidth);
  const [navigationCollapsed, setNavigationCollapsed] = useState(() => localStorage.getItem(NAV_COLLAPSED_KEY) === "1");
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.innerWidth < NAV_FOLD_PX);
  const [taskReloadKey, setTaskReloadKey] = useState(0);
  const [editRequest, setEditRequest] = useState<TaskEditRequest | null>(null);
  const validated = useRef(false);
  const lastCommand = useRef<{ id: string; at: number }>({ id: "", at: 0 });
  const { t } = useI18n();
  const { toggle: toggleTheme } = useTheme();
  const toast = useToast();
  const trafficLights = hasNativeTrafficLights();

  const setActiveTaskId = useCallback((id: string | null) => {
    setActiveTaskIdState(id);
    if (id) localStorage.setItem(ACTIVE_TASK_KEY, id);
    else localStorage.removeItem(ACTIVE_TASK_KEY);
  }, []);

  const refreshTasks = useCallback(async () => {
    try { setTasks(await listAgentTasks()); } catch {}
  }, []);

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${NAV_FOLD_PX - 1}px)`);
    const sync = () => setNarrow(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => { if (status === "connected") refreshTasks(); }, [status, refreshTasks]);

  useEffect(() => {
    if (validated.current || tasks.length === 0) return;
    validated.current = true;
    const stored = localStorage.getItem(ACTIVE_TASK_KEY);
    if (stored && !tasks.some((task) => task.id === stored)) {
      localStorage.removeItem(ACTIVE_TASK_KEY);
      setActiveTaskIdState(null);
    }
  }, [tasks]);

  const fail = (error: unknown) => toast.error(`${t("app.actionFailed")} ${String(error)}`);
  const taskActions: TaskActions = {
    onRename: async (task, title) => {
      try { await patchSession(task.id, { title }); } catch (error) { fail(error); }
      refreshTasks();
      if (task.id === activeTaskId) setTaskReloadKey((key) => key + 1);
    },
    onDelete: async (task) => {
      try { await deleteSession(task.id); if (activeTaskId === task.id) setActiveTaskId(null); dropSessionRun(task.id); } catch (error) { fail(error); }
      refreshTasks();
    },
  };

  const toggleNavigation = useCallback(() => {
    setNavigationCollapsed((collapsed) => { localStorage.setItem(NAV_COLLAPSED_KEY, collapsed ? "0" : "1"); return !collapsed; });
  }, []);

  /** Every window-level command, whether it came from a key, the palette or the native menu. */
  const runCommand = useCallback((command: MenuCommand) => {
    const now = Date.now();
    if (lastCommand.current.id === command && now - lastCommand.current.at < COMMAND_DEDUP_MS) return;
    lastCommand.current = { id: command, at: now };
    const live = getPaletteActions();
    switch (command) {
      case "settings": setSettingsOpen(true); break;
      case "new-task": setActiveTaskId(null); break;
      case "rename-task":
        if (activeTaskId) { setNavigationCollapsed(false); setEditRequest({ id: activeTaskId, kind: "rename", key: now }); }
        break;
      case "delete-task":
        if (activeTaskId) { setNavigationCollapsed(false); setEditRequest({ id: activeTaskId, kind: "delete", key: now }); }
        break;
      case "stop": live.stop?.(); break;
      case "resume": live.resume?.(); break;
      case "toggle-sidebar": toggleNavigation(); break;
      case "find": live.find?.(); break;
      case "review": toggleAgentArtifacts(); break;
      case "palette": setPaletteOpen((open) => !open); break;
      case "focus-composer": live.focusComposer?.(); break;
      case "theme": toggleTheme(); break;
      case "shortcuts": setShortcutsOpen((open) => !open); break;
      case "release-notes": void openExternal(RELEASE_NOTES_URL); break;
    }
  }, [activeTaskId, setActiveTaskId, toggleNavigation, toggleTheme]);

  useNativeShell({
    onOpenTask: useCallback((id: string) => { if (!id || id.length < 8) return; setActiveTaskId(id); }, [setActiveTaskId]),
    onMenuCommand: runCommand,
    onSummon: useCallback(() => { getPaletteActions().focusComposer?.(); }, []),
  });
  useSettleNotifications(tasks, activeTaskId);

  // v1.16 — window-owned palette entries (the shortcuts sheet) survive task
  // switches: the task publisher below never sets them.
  useEffect(() => {
    publishBasePaletteActions({ shortcuts: () => runCommand("shortcuts") });
  }, [runCommand]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (matches(event, "palette")) { event.preventDefault(); runCommand("palette"); }
      else if (matches(event, "newTask")) { event.preventDefault(); runCommand("new-task"); }
      else if (matches(event, "toggleTaskNavigation")) { event.preventDefault(); runCommand("toggle-sidebar"); }
      else if (matches(event, "shortcuts") && !isEditable(event.target)) { event.preventDefault(); runCommand("shortcuts"); }
      else if (matches(event, "stop")) { event.preventDefault(); runCommand("stop"); }
      else if (matches(event, "focusComposer")) { event.preventDefault(); runCommand("focus-composer"); }
      else if (matches(event, "close")) { if (closeTopOverlay()) event.preventDefault(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [runCommand]);

  const sidebarOpen = !navigationCollapsed && !narrow;
  const activeTask = tasks.find((task) => task.id === activeTaskId) ?? null;

  return (
    <div className="native-window">
      <AgentTaskNavigation
        tasks={tasks}
        activeTaskId={activeTaskId}
        onSelectTask={setActiveTaskId}
        onNew={() => setActiveTaskId(null)}
        onSearch={() => runCommand("palette")}
        onOpenSettings={() => setSettingsOpen(true)}
        actions={taskActions}
        editRequest={editRequest}
        width={navigationWidth}
        collapsed={!sidebarOpen}
        trafficLights={trafficLights}
        onToggleCollapse={toggleNavigation}
        onResize={(pixels) => { setNavigationWidth(pixels); localStorage.setItem(NAV_WIDTH_KEY, String(pixels)); }}
      />

      <div className="native-main">
        <TitleBar task={activeTask} sidebarOpen={sidebarOpen} trafficLights={trafficLights} onToggleSidebar={toggleNavigation} onNew={() => setActiveTaskId(null)} />
        <ActiveTaskContext.Provider value={activeTaskId}>
        <AgentShell
          taskId={activeTaskId}
          taskContent={
            <AgentTask
              taskId={activeTaskId}
              onTaskCreated={(id) => { setActiveTaskId(id); refreshTasks(); }}
              sidecarStatus={status}
              onTaskDiscarded={(id) => { if (activeTaskId === id) setActiveTaskId(null); refreshTasks(); }}
              onOpenSettings={() => setSettingsOpen(true)}
              onChanged={refreshTasks}
              sidecarReady={status === "connected"}
              settingsOpen={settingsOpen}
              reloadKey={taskReloadKey}
            />
          }
        />
        </ActiveTaskContext.Provider>
      </div>

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ShortcutsSheet open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} tasks={tasks} onSelectTask={setActiveTaskId} onNew={() => setActiveTaskId(null)} onOpenSettings={() => setSettingsOpen(true)} />
    </div>
  );
}
