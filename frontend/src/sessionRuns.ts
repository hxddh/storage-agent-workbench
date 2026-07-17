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
  uploading: boolean; // a dataset upload is in flight for THIS session (per-session, F2)
  pending: string | null; // the user's in-flight message
  streamText: string | null; // streaming assistant text so far
  streamTools: ToolActivity[];
  proposals: NextAction[] | null; // agent's proposed next steps (null = not answered yet)
  grounding: Grounding | null; // what the last answer was grounded in / couldn't verify
  needKey: boolean;
  error: string | null;
  stopped: boolean; // the user cancelled the turn; keep the partial text visible
  stalled: boolean; // gave up polling for a still-running turn — offer a reload
                    // instead of an eternal "thinking" spinner (v0.24.19).
  failedText: string | null; // a failed turn's message to restore into the
                             // composer when this session is next VISIBLE — set
                             // even when the failure happened off-screen (FE2).
};

const EMPTY: SessionRun = {
  busy: false,
  uploading: false,
  pending: null,
  streamText: null,
  streamTools: [],
  proposals: null,
  grounding: null,
  needKey: false,
  error: null,
  stopped: false,
  stalled: false,
  failedText: null,
};

const store = new Map<string, SessionRun>();
const listeners = new Map<string, Set<() => void>>();
// Sessions the user has deleted. Late writes for a dropped session are ignored
// so an in-flight turn can't resurrect a store entry for a session that's gone
// (F3). Session ids are server UUIDs and never reused, so this only grows by one
// per delete over a run — negligible.
const dropped = new Set<string>();
// How to abort a session's in-flight turn, registered by the turn runner. Lets
// dropSessionRun stop the stream when a session is deleted mid-turn (F3).
const aborters = new Map<string, () => void>();
// How to CANCEL the turn server-side (best-effort). Aborting only the local
// stream left the server worker generating against a deleted session — wasted
// model spend; this asks the server to stop too.
const cancellers = new Map<string, () => void>();

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
  // A deleted session's in-flight turn keeps trying to patch (busy:false, a
  // stopped marker, …). Ignore those so it can't re-create a store entry for a
  // session that's gone (F3).
  if (dropped.has(id)) return;
  const cur = store.get(id) ?? EMPTY;
  const delta = typeof patch === "function" ? patch(cur) : patch;
  store.set(id, { ...cur, ...delta });
  notify(id);
}

/** Register how to abort a session's in-flight turn so dropSessionRun can stop
 * the stream when the session is deleted (F3). Called by the turn runner when a
 * turn starts. */
export function registerTurnAbort(id: string, abort: () => void): void {
  aborters.set(id, abort);
}

/** Unregister a turn's aborter (called when the turn ends). Identity-checked so
 * a finished turn can't clear a newer turn's aborter for the same session. */
export function unregisterTurnAbort(id: string, abort: () => void): void {
  if (aborters.get(id) === abort) aborters.delete(id);
}

/** Register how to cancel a session's in-flight turn SERVER-SIDE (best-effort),
 * so deleting the session also stops the worker, not just the local stream. */
export function registerTurnCancel(id: string, cancel: () => void): void {
  cancellers.set(id, cancel);
}

/** Unregister a turn's server canceller (identity-checked, like the aborter). */
export function unregisterTurnCancel(id: string, cancel: () => void): void {
  if (cancellers.get(id) === cancel) cancellers.delete(id);
}

/** Forget a session's run state and listeners (call when a session is deleted)
 * so the module-level maps don't accumulate entries for dead sessions. Aborts
 * any in-flight turn first and marks the session dropped so late writes from
 * that turn are ignored — no orphan stream, no resurrected entry (F3). */
export function dropSessionRun(id: string): void {
  dropped.add(id);
  cancellers.get(id)?.(); // ask the server to stop the turn (best-effort)
  cancellers.delete(id);
  aborters.get(id)?.();
  aborters.delete(id);
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
