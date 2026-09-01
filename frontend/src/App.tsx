import { useCallback, useEffect, useRef, useState } from "react";
import { closeTopOverlay } from "./lib/overlayStack";
import { AgentTask } from "./components/AgentTask";
import { SettingsDrawer } from "./components/SettingsDrawer";
import { CommandPalette } from "./components/CommandPalette";
import { deleteSession, patchSession } from "./api";
import { dropSessionRun } from "./sessionRuns";
import { useSidecarHealth } from "./hooks/useSidecarHealth";
import { useI18n } from "./i18n";
import { useToast } from "./components/Toast";
import { ShortcutsSheet } from "./components/ShortcutsSheet";
import { isEditable, matches } from "./shortcuts";
import { getPaletteActions } from "./agent/paletteActions";
import { AgentTaskNavigation } from "./agent/AgentTaskNavigation";
import { DEFAULT_TASK_NAV_WIDTH, clampTaskNavigationWidth, type AgentTaskSummary, type TaskActions } from "./agent/navigationModel";
import { AgentShell } from "./agent/AgentShell";
import { listAgentTasks } from "./agent/taskApi";
import { useDeepLink } from "./hooks/useNativeAgent";

const NAV_WIDTH_KEY = "saw.railWidth";
const NAV_COLLAPSED_KEY = "saw.railCollapsed";
const ACTIVE_TASK_KEY = "saw.activeSession";
const DETAILS_KEY = "saw.detailsOpen";
const NAV_FOLD_PX = 1080;

function storedNavigationWidth(): number {
  const raw = Number(localStorage.getItem(NAV_WIDTH_KEY));
  return Number.isFinite(raw) && raw > 0 ? clampTaskNavigationWidth(raw) : DEFAULT_TASK_NAV_WIDTH;
}

function IconBar({
  onNew,
  onToggleNav,
  navOpen,
  onOpenPalette,
  onOpenSettings,
  onToggleDetails,
  detailsOpen,
}: {
  onNew: () => void;
  onToggleNav: () => void;
  navOpen: boolean;
  onOpenPalette: () => void;
  onOpenSettings: () => void;
  onToggleDetails: () => void;
  detailsOpen: boolean;
}) {
  return (
    <div className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-edge bg-sidebar py-2">
      <button onClick={onNew} title="New task" aria-label="New task" className="grid h-9 w-9 place-items-center rounded-md text-gray-400 hover:bg-hover hover:text-gray-100">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14" /></svg>
      </button>
      <button onClick={onToggleNav} aria-pressed={navOpen} title={navOpen ? "Hide explorer" : "Show explorer"} className={`grid h-9 w-9 place-items-center rounded-md ${navOpen ? "bg-elevated text-gray-100" : "text-gray-400 hover:bg-hover hover:text-gray-100"}`}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18" /></svg>
      </button>
      <div className="my-1 h-px w-6 bg-edge" />
      <button onClick={onOpenPalette} title="Command palette" className="grid h-9 w-9 place-items-center rounded-md text-gray-400 hover:bg-hover hover:text-gray-100">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M8 10h8M8 14h5" /></svg>
      </button>
      <button onClick={onToggleDetails} aria-pressed={detailsOpen} title="Toggle details" className={`grid h-9 w-9 place-items-center rounded-md ${detailsOpen ? "bg-elevated text-gray-100" : "text-gray-400 hover:bg-hover hover:text-gray-100"}`}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M15 3v18" /></svg>
      </button>
      <div className="mt-auto flex flex-col items-center gap-1">
        <button onClick={onOpenSettings} title="Settings" aria-label="Open settings" className="grid h-9 w-9 place-items-center rounded-md text-gray-400 hover:bg-hover hover:text-gray-100">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 9 15a1.65 1.65 0 0 0 1-1.51V12a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06A2 2 0 0 1 4.3 8.05l.06-.06A1.65 1.65 0 0 0 5.18 6.17a1.65 1.65 0 0 0 1-1.51V4a2 2 0 0 1 4 0v.07a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06A2 2 0 0 1 15.9 7.95l-.06.06A1.65 1.65 0 0 0 15.5 9.83a1.65 1.65 0 0 0-1 1.51V13a1.65 1.65 0 0 0 1 1.51Z" /></svg>
        </button>
        <div className="h-2" />
      </div>
    </div>
  );
}

export default function App() {
  const { status } = useSidecarHealth();
  const [tasks, setTasks] = useState<AgentTaskSummary[]>([]);
  const [activeTaskId, setActiveTaskIdState] = useState<string | null>(() => localStorage.getItem(ACTIVE_TASK_KEY));
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [navigationWidth, setNavigationWidth] = useState(storedNavigationWidth);
  const [navigationCollapsed, setNavigationCollapsed] = useState(() => localStorage.getItem(NAV_COLLAPSED_KEY) === "1");
  const [detailsOpen, setDetailsOpen] = useState(() => localStorage.getItem(DETAILS_KEY) !== "0");
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.innerWidth < NAV_FOLD_PX);
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
    } catch {}
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

  useDeepLink(useCallback((id: string) => { if (!id || id.length < 8) return; setActiveTaskId(id); }, [setActiveTaskId]));

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
      if (matches(event, "palette")) { event.preventDefault(); setPaletteOpen((o) => !o); }
      else if (matches(event, "newTask")) { event.preventDefault(); setActiveTaskId(null); }
      else if (matches(event, "toggleTaskNavigation")) {
        event.preventDefault();
        setNavigationCollapsed((c) => { localStorage.setItem(NAV_COLLAPSED_KEY, c ? "0" : "1"); return !c; });
      } else if (matches(event, "shortcuts") && !isEditable(event.target)) { event.preventDefault(); setShortcutsOpen((o) => !o); }
      else if (matches(event, "stop")) { event.preventDefault(); getPaletteActions().stop?.(); }
      else if (matches(event, "focusComposer")) { event.preventDefault(); getPaletteActions().focusComposer?.(); }
      else if (matches(event, "close")) { if (closeTopOverlay()) event.preventDefault(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setActiveTaskId]);

  const navOpen = !navigationCollapsed && !narrow;
  const showDetails = detailsOpen && !narrow;

  const navigation = (
    <AgentTaskNavigation
      tasks={tasks}
      activeTaskId={activeTaskId}
      onSelectTask={setActiveTaskId}
      onNew={() => setActiveTaskId(null)}
      onOpenSettings={() => setDrawerOpen(true)}
      actions={taskActions}
      width={navigationWidth}
      collapsed={!navOpen}
      onToggleCollapse={() => setNavigationCollapsed((c) => { localStorage.setItem(NAV_COLLAPSED_KEY, c ? "0" : "1"); return !c; })}
      onResize={(pixels) => { setNavigationWidth(pixels); localStorage.setItem(NAV_WIDTH_KEY, String(pixels)); }}
    />
  );

  const taskContent = (
    <AgentTask
      taskId={activeTaskId}
      onTaskCreated={(id) => { setActiveTaskId(id); refreshTasks(); }}
      sidecarStatus={status}
      onTaskDiscarded={(id) => { if (activeTaskId === id) setActiveTaskId(null); refreshTasks(); }}
      onOpenSettings={() => setDrawerOpen(true)}
      onChanged={refreshTasks}
      sidecarReady={status === "connected"}
      settingsOpen={drawerOpen}
      reloadKey={taskReloadKey}
    />
  );

  return (
    <div className="flex h-full w-full flex-col bg-canvas text-gray-100">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-edge bg-panel px-3 text-xs text-gray-500" data-tauri-drag-region>
        <span className="font-medium tracking-tight text-gray-300">Storage Agent</span>
        <span className="hidden sm:inline text-gray-400">· {status === "connected" ? "Ready" : status === "starting" ? "Starting…" : "Offline"}</span>
        <span className="ml-auto hidden items-center gap-1.5 sm:flex text-gray-400">
          <kbd className="rounded border border-edge bg-elevated px-1.5 py-0.5 text-2xs">⌘K</kbd>
          <span>palette</span>
          <span className="mx-1">·</span>
          <kbd className="rounded border border-edge bg-elevated px-1.5 py-0.5 text-2xs">⌘N</kbd>
          <span>new</span>
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        <IconBar
          onNew={() => setActiveTaskId(null)}
          onToggleNav={() => setNavigationCollapsed((c) => { localStorage.setItem(NAV_COLLAPSED_KEY, c ? "0" : "1"); return !c; })}
          navOpen={navOpen}
          onOpenPalette={() => setPaletteOpen(true)}
          onOpenSettings={() => setDrawerOpen(true)}
          onToggleDetails={() => setDetailsOpen((v) => { localStorage.setItem(DETAILS_KEY, v ? "0" : "1"); return !v; })}
          detailsOpen={showDetails}
        />

        <div
          className="shrink-0 border-r border-edge bg-sidebar overflow-hidden"
          style={{ width: navOpen ? navigationWidth : 0, minWidth: navOpen ? navigationWidth : 0 }}
          aria-hidden={navOpen ? undefined : true}
        >
          <div style={{ width: navigationWidth, minWidth: navigationWidth }}>
            {navigation}
          </div>
        </div>

        <div className="flex min-w-0 flex-1 bg-canvas">
          <AgentShell navigation={null} taskContent={taskContent} taskId={activeTaskId} />
        </div>

        {showDetails && (
          <div className="hidden w-60 shrink-0 border-l border-edge bg-panel lg:flex flex-col">
            <div className="flex h-9 items-center justify-between border-b border-edge px-3">
              <span className="text-xs font-medium text-gray-300">Details</span>
              <button onClick={() => { setDetailsOpen(false); localStorage.setItem(DETAILS_KEY, "0"); }} className="grid h-6 w-6 place-items-center rounded text-gray-400 hover:bg-hover hover:text-gray-200">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="flex-1 overflow-auto p-3 text-xs leading-relaxed text-gray-400">
              <div className="space-y-3">
                <div>
                  <div className="mb-1 font-medium text-gray-300">Task</div>
                  <div className="rounded-md border border-edge bg-canvas px-2.5 py-2 text-gray-300">{activeTaskId ? tasks.find((t) => t.id === activeTaskId)?.title || "Untitled" : "No task selected"}</div>
                </div>
                <div className="h-px bg-edge" />
                <div>
                  <div className="mb-1 font-medium text-gray-300">Shortcuts</div>
                  <div className="space-y-1 text-gray-500">
                    <div className="flex justify-between"><span>Palette</span><kbd>⌘K</kbd></div>
                    <div className="flex justify-between"><span>New task</span><kbd>⌘N</kbd></div>
                    <div className="flex justify-between"><span>Toggle nav</span><kbd>⌘B</kbd></div>
                    <div className="flex justify-between"><span>Focus composer</span><kbd>⌘.</kbd></div>
                    <div className="flex justify-between"><span>Stop</span><kbd>Esc</kbd></div>
                  </div>
                </div>
                <div className="h-px bg-edge" />
                <div className="text-gray-500">
                  <div className="font-medium text-gray-300">Model</div>
                  <div>{status === "connected" ? "Sidecar ready" : "Sidecar " + status}</div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="flex h-5 shrink-0 items-center gap-2 border-t border-edge bg-panel px-2 text-2xs text-gray-500">
        <span className="hidden sm:inline">{tasks.length} tasks</span>
        <span className="sm:hidden">{tasks.length}</span>
        <span>·</span>
        <span>{activeTaskId ? "Task open" : "No task"}</span>
        <span className="ml-auto hidden sm:inline">Storage Agent · local-first · read-only</span>
      </div>

      <SettingsDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
      <ShortcutsSheet open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} tasks={tasks} onSelectTask={setActiveTaskId} onNew={() => setActiveTaskId(null)} onOpenSettings={() => setDrawerOpen(true)} />
    </div>
  );
}
