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
  editing: Editing;
  setEditing: (e: Editing) => void;
  draft: { text: string; nonce: number };
  prefill: (text: string) => void;
  models: ModelProvider[] | null;
  clouds: CloudProvider[] | null;
  reloadProviders: () => Promise<void>;
  online: boolean;
  setOnline: (online: boolean) => void;
  /** Bumped when something changes an Issue (Verify, Accept): the home re-reads. */
  estateRev: number;
  estateChanged: () => void;
};

const AppContext = createContext<Ctx | null>(null);

function readRoute(): Route {
  const hash = window.location.hash;
  const m = /^#\/task\/([A-Za-z0-9_-]+)/.exec(hash);
  return m ? { kind: "task", id: m[1] } : { kind: "home" };
}

/** Below 720 px the sidebar overlays the page: it starts closed and its state is not saved. */
export function isNarrow(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(max-width: 720px)").matches;
}

function storedSidebar(): boolean {
  if (isNarrow()) return false;
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
  const [editing, setEditing] = useState<Editing>(null);
  const [draft, setDraft] = useState({ text: "", nonce: 0 });
  const [models, setModels] = useState<ModelProvider[] | null>(null);
  const [clouds, setClouds] = useState<CloudProvider[] | null>(null);
  const [online, setOnline] = useState(true);
  const [estateRev, setEstateRev] = useState(0);

  // Crossing into a narrow window closes the overlay instead of covering the page with it.
  useEffect(() => {
    const mq = window.matchMedia?.("(max-width: 720px)");
    if (!mq) return;
    const onChange = () => { if (mq.matches) setSidebarState(false); };
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  useEffect(() => {
    const onHash = () => setRoute(readRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const navigate = useCallback((hash: string, next: Route) => {
    const go = () => {
      if (window.location.hash !== hash) window.history.pushState(null, "", hash || "#/");
      setRoute(next);
      if (isNarrow()) setSidebarState(false); // the overlay gives the page back once a page is chosen
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
    openBucket: (providerId, bucket) => {
      if (isNarrow()) setSidebarState(false); // one overlay at a time in a narrow window
      setPane({ tab: "bucket", providerId, bucket });
    },
    pane,
    setPane: (p) => {
      if (p && isNarrow()) setSidebarState(false);
      setPane(p);
    },
    sidebar,
    setSidebar: (open) => {
      setSidebarState(open);
      if (isNarrow()) return; // the overlay's state is not the window's preference
      try { localStorage.setItem("sa.sidebar", open ? "1" : "0"); } catch { /* per-device only */ }
    },
    settings,
    openSettings: (section = "general") => setSettings(section),
    closeSettings: () => { setSettings(null); void reloadProviders(); },
    editing,
    setEditing,
    draft,
    prefill: (text) => setDraft((d) => ({ text, nonce: d.nonce + 1 })),
    models,
    clouds,
    reloadProviders,
    online,
    setOnline,
    estateRev,
    estateChanged: () => setEstateRev((n) => n + 1),
  }), [route, navigate, pane, sidebar, settings, editing, draft, models, clouds, reloadProviders, online, estateRev]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): Ctx {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
