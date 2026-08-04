import { useCallback, useEffect, useState } from "react";
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
import { matches } from "./shortcuts";

const ONBOARDED_KEY = "saw.onboarded";
const RAIL_WIDTH_KEY = "saw.railWidth";
const RAIL_COLLAPSED_KEY = "saw.railCollapsed";

// Read once at mount. A rail that forgets its width every launch is worse than
// one that was never resizable — the user re-does the same drag daily.
function storedRailWidth(): number {
  const raw = Number(localStorage.getItem(RAIL_WIDTH_KEY));
  return Number.isFinite(raw) && raw > 0 ? clampRailWidth(raw) : DEFAULT_RAIL_WIDTH;
}

export default function App() {
  const { status, slow } = useSidecarHealth();
  const [sessions, setSessions] = useState<SessionSummaryRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [railWidth, setRailWidth] = useState(storedRailWidth);
  const [railCollapsed, setRailCollapsed] = useState(
    () => localStorage.getItem(RAIL_COLLAPSED_KEY) === "1",
  );
  // Bumped to force the open Thread to reload when the ACTIVE session changed in
  // a way the thread mirrors (a rename → header title) without a session switch.
  const [threadReloadKey, setThreadReloadKey] = useState(0);
  const { t } = useI18n();
  const toast = useToast();

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
  const fail = (e: unknown) => toast.error(`${t("app.actionFailed")} ${String(e)}`);
  const sessionActions: SessionActions = {
    onRename: async (s, title) => {
      try { await patchSession(s.id, { title }); } catch (e) { fail(e); }
      refreshSessions();
      // The thread header mirrors the title; nudge it to reload if it's the open
      // session (a rename doesn't change activeId, so Thread wouldn't otherwise
      // refresh) (FE6).
      if (s.id === activeId) setThreadReloadKey((k) => k + 1);
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
        // Drop the deleted session's run state + listeners so the sessionRuns
        // module maps don't accumulate entries for dead sessions.
        dropSessionRun(s.id);
      } catch (e) { fail(e); }
      refreshSessions();
    },
  };

  // Global shortcuts: ⌘K command palette, ⌘N new chat, Esc closes overlays.
  useEffect(() => {
    // Editable target: an Escape here belongs to whatever the user is typing in
    // (a settings-drawer field, a rail rename box, etc.), not the global "close
    // overlays" shortcut — otherwise a stray Escape while typing in the drawer
    // would slam it shut mid-edit. Overlays with their own input (the command
    // palette) handle Escape in their own onKeyDown.
    const isEditable = (el: EventTarget | null): boolean => {
      const node = el as HTMLElement | null;
      if (!node) return false;
      const tag = node.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || node.isContentEditable;
    };
    // Matching goes through the shared registry (src/shortcuts.ts), so the help
    // sheet and this handler can never document different chords.
    const onKey = (e: KeyboardEvent) => {
      if (matches(e, "palette")) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (matches(e, "newChat")) {
        e.preventDefault();
        setActiveId(null);
      } else if (matches(e, "toggleRail")) {
        e.preventDefault();
        setRailCollapsed((v) => {
          localStorage.setItem(RAIL_COLLAPSED_KEY, v ? "0" : "1");
          return !v;
        });
      } else if (matches(e, "shortcuts") && !isEditable(e.target)) {
        // Bare "?" only outside a text field — otherwise it would swallow the
        // character mid-sentence in the composer.
        e.preventDefault();
        setShortcutsOpen((o) => !o);
      } else if (matches(e, "close")) {
        if (isEditable(e.target)) return;
        setPaletteOpen(false);
        setDrawerOpen(false);
        setShortcutsOpen(false);
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
        slow={slow}
        actions={sessionActions}
        width={railWidth}
        collapsed={railCollapsed}
        onToggleCollapse={() => setRailCollapsed((v) => {
          localStorage.setItem(RAIL_COLLAPSED_KEY, v ? "0" : "1");
          return !v;
        })}
        onResize={(px) => {
          setRailWidth(px);
          localStorage.setItem(RAIL_WIDTH_KEY, String(px));
        }}
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
        settingsOpen={drawerOpen}
        reloadKey={threadReloadKey}
      />

      <SettingsDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />

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
