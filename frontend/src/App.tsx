import { useCallback, useEffect, useRef, useState } from "react";
import { closeTopOverlay } from "./lib/overlayStack";
import { AgentTask } from "./components/AgentTask";
import { SettingsDialog } from "./components/SettingsDialog";
import { CommandPalette } from "./components/CommandPalette";
import { deleteSession, patchSession } from "./api";
import { dropSessionRun, useSessionRun } from "./sessionRuns";
import { useSidecarHealth } from "./hooks/useSidecarHealth";
import { useI18n } from "./i18n";
import { useToast } from "./components/Toast";
import { ShortcutsSheet } from "./components/ShortcutsSheet";
import { isEditable, matches } from "./shortcuts";
import { getPaletteActions } from "./agent/paletteActions";
import { AgentTaskNavigation } from "./agent/AgentTaskNavigation";
import { useNavigationCopy } from "./agent/navigationCopy";
import { DEFAULT_TASK_NAV_WIDTH, clampTaskNavigationWidth, type AgentTaskSummary, type TaskActions } from "./agent/navigationModel";
import { AgentShell } from "./agent/AgentShell";
import { listAgentTasks } from "./agent/taskApi";
import { agentTaskState } from "./agent/taskState";
import { useDeepLink } from "./hooks/useNativeAgent";
import { hasNativeTrafficLights } from "./config";
import { Icon } from "./components/icons";

const NAV_WIDTH_KEY = "saw.railWidth";
const NAV_COLLAPSED_KEY = "saw.railCollapsed";
const ACTIVE_TASK_KEY = "saw.activeSession";
const NAV_FOLD_PX = 1080;

function storedNavigationWidth(): number {
  const raw = Number(localStorage.getItem(NAV_WIDTH_KEY));
  return Number.isFinite(raw) && raw > 0 ? clampTaskNavigationWidth(raw) : DEFAULT_TASK_NAV_WIDTH;
}

/** Window title row over the document: the task name, and its real state. */
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
      <span className="native-titlebar-title" data-task={task ? "true" : "false"} data-tauri-drag-region>{title}</span>
      {stateLabel ? (
        <span className="native-titlebar-state" data-state={state} data-testid="titlebar-state">
          {state === "working" || state === "uploading" ? <span className="working-mark" style={{ width: 6, height: 6 }} aria-hidden /> : null}
          {stateLabel}
        </span>
      ) : null}
    </header>
  );
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
  const validated = useRef(false);
  const { t } = useI18n();
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

  useDeepLink(useCallback((id: string) => { if (!id || id.length < 8) return; setActiveTaskId(id); }, [setActiveTaskId]));

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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (matches(event, "palette")) { event.preventDefault(); setPaletteOpen((open) => !open); }
      else if (matches(event, "newTask")) { event.preventDefault(); setActiveTaskId(null); }
      else if (matches(event, "toggleTaskNavigation")) { event.preventDefault(); toggleNavigation(); }
      else if (matches(event, "shortcuts") && !isEditable(event.target)) { event.preventDefault(); setShortcutsOpen((open) => !open); }
      else if (matches(event, "stop")) { event.preventDefault(); getPaletteActions().stop?.(); }
      else if (matches(event, "focusComposer")) { event.preventDefault(); getPaletteActions().focusComposer?.(); }
      else if (matches(event, "close")) { if (closeTopOverlay()) event.preventDefault(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setActiveTaskId, toggleNavigation]);

  const sidebarOpen = !navigationCollapsed && !narrow;
  const activeTask = tasks.find((task) => task.id === activeTaskId) ?? null;

  return (
    <div className="native-window">
      <AgentTaskNavigation
        tasks={tasks}
        activeTaskId={activeTaskId}
        onSelectTask={setActiveTaskId}
        onNew={() => setActiveTaskId(null)}
        onOpenSettings={() => setSettingsOpen(true)}
        actions={taskActions}
        width={navigationWidth}
        collapsed={!sidebarOpen}
        trafficLights={trafficLights}
        onToggleCollapse={toggleNavigation}
        onResize={(pixels) => { setNavigationWidth(pixels); localStorage.setItem(NAV_WIDTH_KEY, String(pixels)); }}
      />

      <div className="native-main">
        <TitleBar task={activeTask} sidebarOpen={sidebarOpen} trafficLights={trafficLights} onToggleSidebar={toggleNavigation} onNew={() => setActiveTaskId(null)} />
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
      </div>

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ShortcutsSheet open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} tasks={tasks} onSelectTask={setActiveTaskId} onNew={() => setActiveTaskId(null)} onOpenSettings={() => setSettingsOpen(true)} />
    </div>
  );
}
