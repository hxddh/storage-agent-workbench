import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../api";
import type { CloudProvider, ModelProvider } from "../api/types";

/**
 * Window state that more than one surface reads: where the reader is (the
 * home or one task), the side pane, the sidebar, and the configured model and
 * storage accounts. Work itself lives in the task store, never here.
 */

export type Route = { kind: "home" } | { kind: "task"; id: string };
/** The one side pane: a task's Details (every call, files, the report), or one bucket. */
export type Pane =
  | { tab: "details"; callId?: string }
  | { tab: "bucket"; providerId: string; bucket: string }
  | null;
export type Editing = { turnId: string; parentTurnId: string | null; text: string } | null;

type Ctx = {
  route: Route;
  openTask: (id: string) => void;
  goHome: () => void;
  openBucket: (providerId: string, bucket: string) => void;
  pane: Pane;
  setPane: (p: Pane) => void;
  sidebar: boolean;
  setSidebar: (open: boolean) => void;
  settings: string | null;
  openSettings: (section?: string) => void;
  closeSettings: () => void;
  palette: boolean;
  setPalette: (open: boolean) => void;
  editing: Editing;
  setEditing: (e: Editing) => void;
  draft: { text: string; nonce: number };
  prefill: (text: string) => void;
  models: ModelProvider[] | null;
  clouds: CloudProvider[] | null;
  reloadProviders: () => Promise<void>;
  online: boolean;
  setOnline: (online: boolean) => void;
};

const AppContext = createContext<Ctx | null>(null);

function readRoute(): Route {
  const hash = window.location.hash;
  const m = /^#\/task\/([A-Za-z0-9_-]+)/.exec(hash);
  return m ? { kind: "task", id: m[1] } : { kind: "home" };
}

function storedSidebar(): boolean {
  try {
    return localStorage.getItem("sa.sidebar") !== "0";
  } catch {
    return true;
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [route, setRoute] = useState<Route>(readRoute);
  const [pane, setPane] = useState<Pane>(null);
  const [sidebar, setSidebarState] = useState(storedSidebar);
  const [settings, setSettings] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const [draft, setDraft] = useState({ text: "", nonce: 0 });
  const [models, setModels] = useState<ModelProvider[] | null>(null);
  const [clouds, setClouds] = useState<CloudProvider[] | null>(null);
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const onHash = () => setRoute(readRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const navigate = useCallback((hash: string, next: Route) => {
    const go = () => {
      if (window.location.hash !== hash) window.history.pushState(null, "", hash || "#/");
      setRoute(next);
      setEditing(null);
      setDraft({ text: "", nonce: 0 }); // a draft belongs to the page it was written on
    };
    const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (doc.startViewTransition && !reduce) doc.startViewTransition(go);
    else go();
  }, []);

  const reloadProviders = useCallback(async () => {
    try {
      const [m, c] = await Promise.all([api.models(), api.clouds()]);
      setModels(m);
      setClouds(c);
      setOnline(true);
    } catch {
      setOnline(false);
    }
  }, []);

  useEffect(() => {
    void reloadProviders();
  }, [reloadProviders]);

  const value = useMemo<Ctx>(() => ({
    route,
    openTask: (id) => navigate(`#/task/${id}`, { kind: "task", id }),
    goHome: () => navigate("#/", { kind: "home" }),
    openBucket: (providerId, bucket) => setPane({ tab: "bucket", providerId, bucket }),
    pane,
    setPane,
    sidebar,
    setSidebar: (open) => {
      setSidebarState(open);
      try { localStorage.setItem("sa.sidebar", open ? "1" : "0"); } catch { /* per-device only */ }
    },
    settings,
    openSettings: (section = "general") => setSettings(section),
    closeSettings: () => { setSettings(null); void reloadProviders(); },
    palette,
    setPalette,
    editing,
    setEditing,
    draft,
    prefill: (text) => setDraft((d) => ({ text, nonce: d.nonce + 1 })),
    models,
    clouds,
    reloadProviders,
    online,
    setOnline,
  }), [route, navigate, pane, sidebar, settings, palette, editing, draft, models, clouds, reloadProviders, online]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): Ctx {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
