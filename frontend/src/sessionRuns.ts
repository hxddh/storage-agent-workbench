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
 * The run loop (in Thread) writes to the entry for the id it started with, not
 * the currently-visible session, so streams never bleed across sessions.
 */
import { useSyncExternalStore } from "react";
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

/** Subscribe a component to one session's run state (re-renders on change). */
export function useSessionRun(id: string | null): SessionRun {
  return useSyncExternalStore(
    (cb) => {
      if (!id) return () => {};
      let set = listeners.get(id);
      if (!set) {
        set = new Set();
        listeners.set(id, set);
      }
      set.add(cb);
      return () => set!.delete(cb);
    },
    () => getSessionRun(id),
  );
}
