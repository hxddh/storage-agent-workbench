import { useCallback, useEffect, useState } from "react";
import { SessionRail } from "./components/SessionRail";
import { Thread } from "./components/Thread";
import { SettingsDrawer } from "./components/SettingsDrawer";
import { FirstRunWizard } from "./components/FirstRunWizard";
import { CommandPalette } from "./components/CommandPalette";
import { listCloudProviders, listModelProviders, listSessions } from "./api";
import type { SessionSummaryRow } from "./types";
import { useSidecarHealth } from "./hooks/useSidecarHealth";

const ONBOARDED_KEY = "saw.onboarded";

export default function App() {
  const { status, service, slow } = useSidecarHealth();
  const [sessions, setSessions] = useState<SessionSummaryRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

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
      <SessionRail
        sessions={sessions}
        activeId={activeId}
        onSelect={setActiveId}
        onNew={() => setActiveId(null)}
        onOpenSettings={() => setDrawerOpen(true)}
        status={status}
        service={service}
        slow={slow}
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

      <SettingsDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />

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
