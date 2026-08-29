import { useCallback, useEffect, useRef, useState } from "react";
import { closeTopOverlay } from "./lib/overlayStack";
import {
  SessionRail,
  DEFAULT_RAIL_WIDTH,
  clampRailWidth,
} from "./components/SessionRail";
import { Thread } from "./components/Thread";
import { SettingsDrawer } from "./components/SettingsDrawer";
import { FirstRunWizard } from "./components/FirstRunWizard";
import { CommandPalette } from "./components/CommandPalette";
import type { SessionActions } from "./components/SessionRail";
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
import { WorkbenchShell } from "./workbench/WorkbenchShell";

const ONBOARDED_KEY = "saw.onboarded";
const RAIL_WIDTH_KEY = "saw.railWidth";
const RAIL_COLLAPSED_KEY = "saw.railCollapsed";
const ACTIVE_SESSION_KEY = "saw.activeSession";
const RAIL_FOLD_PX = 1000;

function storedRailWidth(): number {
  const raw = Number(localStorage.getItem(RAIL_WIDTH_KEY));
  return Number.isFinite(raw) && raw > 0 ? clampRailWidth(raw) : DEFAULT_RAIL_WIDTH;
}

export default function App() {
  const { status, slow } = useSidecarHealth();
  const [sessions, setSessions] = useState<SessionSummaryRow[]>([]);
  const [activeId, setActiveIdState] = useState<string | null>(
    () => localStorage.getItem(ACTIVE_SESSION_KEY),
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [railWidth, setRailWidth] = useState(storedRailWidth);
  const [railCollapsed, setRailCollapsed] = useState(
    () => localStorage.getItem(RAIL_COLLAPSED_KEY) === "1",
  );
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.innerWidth < RAIL_FOLD_PX,
  );
  const [threadReloadKey, setThreadReloadKey] = useState(0);
  const validated = useRef(false);
  const { t } = useI18n();
  const toast = useToast();

  const setActiveId = useCallback((id: string | null) => {
    setActiveIdState(id);
    if (id) localStorage.setItem(ACTIVE_SESSION_KEY, id);
    else localStorage.removeItem(ACTIVE_SESSION_KEY);
  }, []);

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await listSessions());
    } catch {
      // The shell remains usable while the sidecar is starting; health owns the
      // visible connection state rather than turning a list refresh into chrome.
    }
  }, []);

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${RAIL_FOLD_PX - 1}px)`);
    const sync = () => setNarrow(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (status === "connected") refreshSessions();
  }, [status, refreshSessions]);

  useEffect(() => {
    if (validated.current || sessions.length === 0) return;
    validated.current = true;
    const stored = localStorage.getItem(ACTIVE_SESSION_KEY);
    if (stored && !sessions.some((session) => session.id === stored)) {
      localStorage.removeItem(ACTIVE_SESSION_KEY);
      setActiveIdState(null);
    }
  }, [sessions]);

  useEffect(() => {
    if (status !== "connected") return;
    if (localStorage.getItem(ONBOARDED_KEY)) return;
    let cancelled = false;
    void Promise.all([listModelProviders(), listCloudProviders()])
      .then(([models, clouds]) => {
        if (!cancelled && models.length === 0 && clouds.length === 0) setShowWizard(true);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [status]);

  const dismissWizard = () => {
    localStorage.setItem(ONBOARDED_KEY, "1");
    setShowWizard(false);
  };

  const fail = (error: unknown) => toast.error(`${t("app.actionFailed")} ${String(error)}`);
  const sessionActions: SessionActions = {
    onRename: async (session, title) => {
      try { await patchSession(session.id, { title }); } catch (error) { fail(error); }
      refreshSessions();
      if (session.id === activeId) setThreadReloadKey((key) => key + 1);
    },
    onTogglePin: async (session) => {
      try { await patchSession(session.id, { pinned: !session.pinned }); } catch (error) { fail(error); }
      refreshSessions();
    },
    onFork: async (session) => {
      try {
        const fork = await forkSession(session.id);
        if (fork) setActiveId(fork.id);
      } catch (error) { fail(error); }
      refreshSessions();
    },
    onToggleArchive: async (session) => {
      try {
        await patchSession(session.id, { status: session.status === "archived" ? "active" : "archived" });
      } catch (error) { fail(error); }
      refreshSessions();
    },
    onDelete: async (session) => {
      try {
        await deleteSession(session.id);
        if (activeId === session.id) setActiveId(null);
        dropSessionRun(session.id);
      } catch (error) { fail(error); }
      refreshSessions();
    },
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (matches(event, "palette")) {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (matches(event, "newChat")) {
        event.preventDefault();
        setActiveId(null);
      } else if (matches(event, "toggleRail")) {
        event.preventDefault();
        setRailCollapsed((collapsed) => {
          localStorage.setItem(RAIL_COLLAPSED_KEY, collapsed ? "0" : "1");
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

  const railFolded = railCollapsed || narrow;
  const activeSession = sessions.find((session) => session.id === activeId) ?? null;

  const navigation = (
    <SessionRail
      sessions={sessions}
      activeId={activeId}
      onSelect={setActiveId}
      onNew={() => setActiveId(null)}
      onOpenSettings={() => setDrawerOpen(true)}
      status={status}
      slow={slow}
      actions={sessionActions}
      width={railWidth}
      collapsed={railFolded}
      onOpenPalette={() => setPaletteOpen(true)}
      onToggleCollapse={() => setRailCollapsed((collapsed) => {
        localStorage.setItem(RAIL_COLLAPSED_KEY, collapsed ? "0" : "1");
        return !collapsed;
      })}
      onResize={(pixels) => {
        setRailWidth(pixels);
        localStorage.setItem(RAIL_WIDTH_KEY, String(pixels));
      }}
    />
  );

  const timeline = (
    <Thread
      sessionId={activeId}
      onSessionCreated={(id) => {
        setActiveId(id);
        refreshSessions();
      }}
      sidecarStatus={status}
      onSessionDiscarded={(id) => {
        if (activeId === id) setActiveId(null);
        refreshSessions();
      }}
      onOpenSettings={() => setDrawerOpen(true)}
      onChanged={refreshSessions}
      sidecarReady={status === "connected"}
      settingsOpen={drawerOpen}
      reloadKey={threadReloadKey}
    />
  );

  return (
    <div className="h-full w-full bg-canvas text-gray-200">
      <WorkbenchShell
        navigation={navigation}
        timeline={timeline}
        sessionId={activeId}
        session={activeSession}
        sidecarStatus={status}
        onOpenPalette={() => setPaletteOpen(true)}
        onOpenSettings={() => setDrawerOpen(true)}
      />

      <SettingsDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
      <ShortcutsSheet open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        sessions={sessions}
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
