/**
 * Per-session in-flight run state, kept OUTSIDE the Thread component.
 *
 * The Thread is a single instance (App doesn't key it by session id), so any
 * run state held in Thread's own React state is lost when you switch sessions —
 * an in-progress turn's streaming text and "busy" status would vanish, and come
 * back only if/when you returned *and* it had already finished. Holding that
 * state here, keyed by session id, lets each session's run keep going and keep
 * its live content while you work in another session; switching back restores it.
 *
 * The run loop (in useTurnRunner) writes to the entry for the id it started
 * with, not the currently-visible session, so streams never bleed across
 * sessions.
 */
import { useCallback, useSyncExternalStore } from "react";
import type { Grounding, NextAction, ToolActivity } from "./types";

export type SessionRun = {
  busy: boolean;
  pending: string | null; // the user's in-flight message
  streamText: string | null; // streaming assistant text so far
  streamTools: ToolActivity[];
  proposals: NextAction[] | null; // agent's proposed next steps (null = not answered yet)
  grounding: Grounding | null; // what the last answer was grounded in / couldn't verify
  needKey: boolean;
  error: string | null;
  stopped: boolean; // the user cancelled the turn; keep the partial text visible
};

const EMPTY: SessionRun = {
  busy: false,
  pending: null,
  streamText: null,
  streamTools: [],
  proposals: null,
  grounding: null,
  needKey: false,
  error: null,
  stopped: false,
};

const store = new Map<string, SessionRun>();
const listeners = new Map<string, Set<() => void>>();

function notify(id: string) {
  listeners.get(id)?.forEach((l) => l());
}

export function getSessionRun(id: string | null): SessionRun {
  if (!id) return EMPTY;
  return store.get(id) ?? EMPTY;
}

export function patchSessionRun(
  id: string,
  patch: Partial<SessionRun> | ((s: SessionRun) => Partial<SessionRun>),
): void {
  const cur = store.get(id) ?? EMPTY;
  const delta = typeof patch === "function" ? patch(cur) : patch;
  store.set(id, { ...cur, ...delta });
  notify(id);
}

/** Forget a session's run state and listeners (call when a session is deleted)
 * so the module-level maps don't accumulate entries for dead sessions. */
export function dropSessionRun(id: string): void {
  store.delete(id);
  listeners.delete(id);
}

function subscribe(id: string | null, cb: () => void): () => void {
  if (!id) return () => {};
  let set = listeners.get(id);
  if (!set) {
    set = new Set();
    listeners.set(id, set);
  }
  set.add(cb);
  return () => {
    set!.delete(cb);
    // Prune the (now empty) listener set so the map doesn't grow forever.
    if (set!.size === 0 && listeners.get(id) === set) listeners.delete(id);
  };
}

/** Subscribe a component to one session's run state (re-renders on change). */
export function useSessionRun(id: string | null): SessionRun {
  // Stable subscribe callback per id: an inline closure would get a new
  // identity on every render, making useSyncExternalStore unsubscribe and
  // resubscribe each time.
  const sub = useCallback((cb: () => void) => subscribe(id, cb), [id]);
  const getSnapshot = useCallback(() => getSessionRun(id), [id]);
  return useSyncExternalStore(sub, getSnapshot);
}
