import { useCallback, useEffect, useRef, useState } from "react";
import { closeTopOverlay } from "./lib/overlayStack";
import { AgentTask } from "./components/AgentTask";
import { SettingsDrawer } from "./components/SettingsDrawer";
import { CommandPalette } from "./components/CommandPalette";
import {
  deleteSession,
  patchSession,
} from "./api";
import { dropSessionRun } from "./sessionRuns";
import { useSidecarHealth } from "./hooks/useSidecarHealth";
import { useI18n } from "./i18n";
import { useToast } from "./components/Toast";
import { ShortcutsSheet } from "./components/ShortcutsSheet";
import { isEditable, matches } from "./shortcuts";
import { getPaletteActions } from "./agent/paletteActions";
import { AgentTaskNavigation } from "./agent/AgentTaskNavigation";
import {
  DEFAULT_TASK_NAV_WIDTH,
  clampTaskNavigationWidth,
  type AgentTaskSummary,
  type TaskActions,
} from "./agent/navigationModel";
import { AgentShell } from "./agent/AgentShell";
import { listAgentTasks } from "./agent/taskApi";

// Persisted-data migration keys from pre-v0.93 builds. Keeping them preserves
// local layout/task continuity; they are not public product vocabulary.
const NAV_WIDTH_KEY = "saw.railWidth";
const NAV_COLLAPSED_KEY = "saw.railCollapsed";
const ACTIVE_TASK_KEY = "saw.activeSession";
const NAV_FOLD_PX = 1000;

function storedNavigationWidth(): number {
  const raw = Number(localStorage.getItem(NAV_WIDTH_KEY));
  return Number.isFinite(raw) && raw > 0 ? clampTaskNavigationWidth(raw) : DEFAULT_TASK_NAV_WIDTH;
}

export default function App() {
  const { status } = useSidecarHealth();
  const [tasks, setTasks] = useState<AgentTaskSummary[]>([]);
  const [activeTaskId, setActiveTaskIdState] = useState<string | null>(
    () => localStorage.getItem(ACTIVE_TASK_KEY),
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [navigationWidth, setNavigationWidth] = useState(storedNavigationWidth);
  const [navigationCollapsed, setNavigationCollapsed] = useState(
    () => localStorage.getItem(NAV_COLLAPSED_KEY) === "1",
  );
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.innerWidth < NAV_FOLD_PX,
  );
  const [taskReloadKey, setTaskReloadKey] = useState(0);
  const validated = useRef(false);
  const { t } = useI18n();
  const toast = useToast();

  const setActiveTaskId = useCallback((id: string | null) => {
    setActiveTaskIdState(id);
    if (id) localStorage.setItem(ACTIVE_TASK_KEY, id);
    else localStorage.removeItem(ACTIVE_TASK_KEY);
  }, []);

  const refreshTasks = useCallback(async () => {
    try {
      setTasks(await listAgentTasks());
    } catch {
      // Connection state belongs to the shell. A refresh failure must not turn
      // task navigation into a second, contradictory health indicator.
    }
  }, []);

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${NAV_FOLD_PX - 1}px)`);
    const sync = () => setNarrow(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (status === "connected") refreshTasks();
  }, [status, refreshTasks]);

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
      try {
        await deleteSession(task.id);
        if (activeTaskId === task.id) setActiveTaskId(null);
        dropSessionRun(task.id);
      } catch (error) { fail(error); }
      refreshTasks();
    },
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (matches(event, "palette")) {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (matches(event, "newTask")) {
        event.preventDefault();
        setActiveTaskId(null);
      } else if (matches(event, "toggleTaskNavigation")) {
        event.preventDefault();
        setNavigationCollapsed((collapsed) => {
          localStorage.setItem(NAV_COLLAPSED_KEY, collapsed ? "0" : "1");
          return !collapsed;
        });
      } else if (matches(event, "shortcuts") && !isEditable(event.target)) {
        event.preventDefault();
        setShortcutsOpen((open) => !open);
      } else if (matches(event, "stop")) {
        event.preventDefault();
        getPaletteActions().stop?.();
      } else if (matches(event, "focusComposer")) {
        event.preventDefault();
        getPaletteActions().focusComposer?.();
      } else if (matches(event, "close")) {
        if (closeTopOverlay()) event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setActiveTaskId]);

  const navigationFolded = navigationCollapsed || narrow;
  const activeTask = tasks.find((task) => task.id === activeTaskId) ?? null;

  const navigation = (
    <AgentTaskNavigation
      tasks={tasks}
      activeTaskId={activeTaskId}
      onSelectTask={setActiveTaskId}
      onNew={() => setActiveTaskId(null)}
      onOpenSettings={() => setDrawerOpen(true)}
      actions={taskActions}
      width={navigationWidth}
      collapsed={navigationFolded}
      onToggleCollapse={() => setNavigationCollapsed((collapsed) => {
        localStorage.setItem(NAV_COLLAPSED_KEY, collapsed ? "0" : "1");
        return !collapsed;
      })}
      onResize={(pixels) => {
        setNavigationWidth(pixels);
        localStorage.setItem(NAV_WIDTH_KEY, String(pixels));
      }}
    />
  );

  const taskContent = (
    <AgentTask
      taskId={activeTaskId}
      onTaskCreated={(id) => {
        setActiveTaskId(id);
        refreshTasks();
      }}
      sidecarStatus={status}
      onTaskDiscarded={(id) => {
        if (activeTaskId === id) setActiveTaskId(null);
        refreshTasks();
      }}
      onOpenSettings={() => setDrawerOpen(true)}
      onChanged={refreshTasks}
      sidecarReady={status === "connected"}
      settingsOpen={drawerOpen}
      reloadKey={taskReloadKey}
    />
  );

  return (
    <div className="h-full w-full bg-canvas text-gray-200">
      <AgentShell
        navigation={navigation}
        taskContent={taskContent}
        taskId={activeTaskId}
        task={activeTask}
        sidecarStatus={status}
        onOpenPalette={() => setPaletteOpen(true)}
        onOpenSettings={() => setDrawerOpen(true)}
      />

      <SettingsDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
      <ShortcutsSheet open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        tasks={tasks}
        onSelectTask={setActiveTaskId}
        onNew={() => setActiveTaskId(null)}
        onOpenSettings={() => setDrawerOpen(true)}
      />
    </div>
  );
}
