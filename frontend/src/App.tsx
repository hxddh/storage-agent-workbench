import { useCallback, useEffect, useState } from "react";
import { SessionRail } from "./components/SessionRail";
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
import { useSidecarHealth } from "./hooks/useSidecarHealth";
import { useI18n } from "./i18n";

const ONBOARDED_KEY = "saw.onboarded";

export default function App() {
  const { status, service, slow } = useSidecarHealth();
  const [sessions, setSessions] = useState<SessionSummaryRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const { t } = useI18n();

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await listSessions());
    } catch {
      /* sidecar not ready yet */
    }
  }, []);

  // Load sessions once the sidecar is connected.
  useEffect(() => {
    if (status === "connected") refreshSessions();
  }, [status, refreshSessions]);

  // First-run: show the wizard if no providers are configured and it hasn't been dismissed.
  useEffect(() => {
    if (status !== "connected") return;
    if (localStorage.getItem(ONBOARDED_KEY)) return;
    let cancelled = false;
    (async () => {
      try {
        const [models, clouds] = await Promise.all([listModelProviders(), listCloudProviders()]);
        if (!cancelled && models.length === 0 && clouds.length === 0) setShowWizard(true);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status]);

  const dismissWizard = () => {
    localStorage.setItem(ONBOARDED_KEY, "1");
    setShowWizard(false);
  };

  // Session management actions (rail ⋯ menu). Optimistic-ish: act, then refresh.
  // Failures surface a dismissible banner instead of being silently swallowed.
  const fail = (e: unknown) => setActionError(`${t("app.actionFailed")} ${String(e)}`);
  const sessionActions: SessionActions = {
    onRename: async (s, title) => {
      try { await patchSession(s.id, { title }); } catch (e) { fail(e); }
      refreshSessions();
    },
    onTogglePin: async (s) => {
      try { await patchSession(s.id, { pinned: !s.pinned }); } catch (e) { fail(e); }
      refreshSessions();
    },
    onFork: async (s) => {
      try {
        const d = await forkSession(s.id);
        if (d) setActiveId(d.id);
      } catch (e) { fail(e); }
      refreshSessions();
    },
    onToggleArchive: async (s) => {
      try { await patchSession(s.id, { status: s.status === "archived" ? "active" : "archived" }); }
      catch (e) { fail(e); }
      refreshSessions();
    },
    onDelete: async (s) => {
      try {
        await deleteSession(s.id);
        if (activeId === s.id) setActiveId(null);
      } catch (e) { fail(e); }
      refreshSessions();
    },
  };

  // Global shortcuts: ⌘K command palette, ⌘N new chat, Esc closes overlays.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (meta && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setActiveId(null);
      } else if (e.key === "Escape") {
        setPaletteOpen(false);
        setDrawerOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-full w-full bg-canvas text-gray-200">
      {actionError && (
        <div className="fixed left-1/2 top-4 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-red-500/40 bg-red-950/90 px-4 py-2 text-sm text-red-200 shadow-lg">
          <span>{actionError}</span>
          <button className="text-red-300 hover:text-red-100" onClick={() => setActionError(null)}>✕</button>
        </div>
      )}
      <SessionRail
        sessions={sessions}
        activeId={activeId}
        onSelect={setActiveId}
        onNew={() => setActiveId(null)}
        onOpenSettings={() => setDrawerOpen(true)}
        status={status}
        service={service}
        slow={slow}
        actions={sessionActions}
      />

      <Thread
        sessionId={activeId}
        onSessionCreated={(id) => {
          setActiveId(id);
          refreshSessions();
        }}
        onOpenSettings={() => setDrawerOpen(true)}
        onChanged={refreshSessions}
        sidecarReady={status === "connected"}
      />

      <SettingsDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />

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
