import { useCallback, useEffect, useRef, useState } from "react";
import { closeTopOverlay } from "./lib/overlayStack";
import { AgentTask } from "./components/AgentTask";
import { SettingsDrawer } from "./components/SettingsDrawer";
import { FirstRunWizard } from "./components/FirstRunWizard";
import { CommandPalette } from "./components/CommandPalette";
import {
  deleteSession,
  forkSession,
  listCloudProviders,
  listModelProviders,
  listSessions,
  patchSession,
} from "./api";
import type { SessionSummaryRow } from "./types";
import { dropSessionRun } from "./sessionRuns";
import { useSidecarHealth } from "./hooks/useSidecarHealth";
import { useI18n } from "./i18n";
import { useToast } from "./components/Toast";
import { ShortcutsSheet } from "./components/ShortcutsSheet";
import { isEditable, matches } from "./shortcuts";
import { AgentTaskNavigation } from "./agent/AgentTaskNavigation";
import {
  DEFAULT_TASK_NAV_WIDTH,
  clampTaskNavigationWidth,
  type SessionActions,
} from "./agent/navigationModel";
import { AgentShell } from "./agent/AgentShell";

const ONBOARDED_KEY = "saw.onboarded";
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
  const { status, slow } = useSidecarHealth();
  const [tasks, setTasks] = useState<SessionSummaryRow[]>([]);
  const [activeId, setActiveIdState] = useState<string | null>(
    () => localStorage.getItem(ACTIVE_TASK_KEY),
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
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

  const setActiveId = useCallback((id: string | null) => {
    setActiveIdState(id);
    if (id) localStorage.setItem(ACTIVE_TASK_KEY, id);
    else localStorage.removeItem(ACTIVE_TASK_KEY);
  }, []);

  const refreshTasks = useCallback(async () => {
    try {
      setTasks(await listSessions());
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
      setActiveIdState(null);
    }
  }, [tasks]);

  useEffect(() => {
    if (status !== "connected") return;
    if (localStorage.getItem(ONBOARDED_KEY)) return;
    let cancelled = false;
    void Promise.all([listModelProviders(), listCloudProviders()])
      .then(([models, clouds]) => {
        // Provider discovery may finish after the user has already dismissed the
        // first-run surface. Re-check durable onboarding state at resolution time
        // so a stale async result can never reopen a modal the user just closed.
        if (
          !cancelled &&
          !localStorage.getItem(ONBOARDED_KEY) &&
          models.length === 0 &&
          clouds.length === 0
        ) {
          setShowWizard(true);
        }
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [status]);

  const dismissWizard = () => {
    localStorage.setItem(ONBOARDED_KEY, "1");
    setShowWizard(false);
  };

  const fail = (error: unknown) => toast.error(`${t("app.actionFailed")} ${String(error)}`);
  const taskActions: SessionActions = {
    onRename: async (task, title) => {
      try { await patchSession(task.id, { title }); } catch (error) { fail(error); }
      refreshTasks();
      if (task.id === activeId) setTaskReloadKey((key) => key + 1);
    },
    onTogglePin: async (task) => {
      try { await patchSession(task.id, { pinned: !task.pinned }); } catch (error) { fail(error); }
      refreshTasks();
    },
    onFork: async (task) => {
      try {
        const fork = await forkSession(task.id);
        if (fork) setActiveId(fork.id);
      } catch (error) { fail(error); }
      refreshTasks();
    },
    onToggleArchive: async (task) => {
      try {
        await patchSession(task.id, { status: task.status === "archived" ? "active" : "archived" });
      } catch (error) { fail(error); }
      refreshTasks();
    },
    onDelete: async (task) => {
      try {
        await deleteSession(task.id);
        if (activeId === task.id) setActiveId(null);
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
        setActiveId(null);
      } else if (matches(event, "toggleTaskNavigation")) {
        event.preventDefault();
        setNavigationCollapsed((collapsed) => {
          localStorage.setItem(NAV_COLLAPSED_KEY, collapsed ? "0" : "1");
          return !collapsed;
        });
      } else if (matches(event, "shortcuts") && !isEditable(event.target)) {
        event.preventDefault();
        setShortcutsOpen((open) => !open);
      } else if (matches(event, "close")) {
        if (closeTopOverlay()) event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setActiveId]);

  const navigationFolded = navigationCollapsed || narrow;
  const activeTask = tasks.find((task) => task.id === activeId) ?? null;

  const navigation = (
    <AgentTaskNavigation
      sessions={tasks}
      activeId={activeId}
      onSelect={setActiveId}
      onNew={() => setActiveId(null)}
      onOpenSettings={() => setDrawerOpen(true)}
      status={status}
      slow={slow}
      actions={taskActions}
      width={navigationWidth}
      collapsed={navigationFolded}
      onOpenPalette={() => setPaletteOpen(true)}
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
      sessionId={activeId}
      onSessionCreated={(id) => {
        setActiveId(id);
        refreshTasks();
      }}
      sidecarStatus={status}
      onSessionDiscarded={(id) => {
        if (activeId === id) setActiveId(null);
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
        sessionId={activeId}
        session={activeTask}
        sidecarStatus={status}
        onOpenPalette={() => setPaletteOpen(true)}
        onOpenSettings={() => setDrawerOpen(true)}
      />

      <SettingsDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
      <ShortcutsSheet open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        sessions={tasks}
        onSelectSession={setActiveId}
        onNew={() => setActiveId(null)}
        onOpenSettings={() => setDrawerOpen(true)}
      />

      {showWizard && (
        <FirstRunWizard
          onConfigure={() => {
            dismissWizard();
            setDrawerOpen(true);
          }}
          onDismiss={dismissWizard}
        />
      )}
    </div>
  );
}
