/**
 * Per-task in-flight Agent runtime state, kept outside the task renderer.
 *
 * The application keeps one visible task renderer while multiple tasks may be
 * executing. Runtime state therefore lives here, keyed by the durable backend
 * session id, so work keeps streaming when the operator switches tasks and the
 * task list can reflect that state without inventing background workers.
 */
import { useCallback, useSyncExternalStore } from "react";
import type { ExecutionMetrics } from "./types";
import type { TaskStatusPayload } from "./api";
import type { LiveTurn, TurnItem } from "./lib/turnItems";

export type SessionRun = {
  busy: boolean;
  uploading: boolean;
  pending: string | null;
  /** Ordered live transcript items of the current turn (commentary, tool
   * rows, approvals) BEFORE the answer. See lib/turnItems. */
  items: TurnItem[];
  /** The final segment, once the model closed it. */
  answer: string | null;
  /** The execution is parked on an inline approval; the worker is alive. */
  waiting: boolean;
  /** When this client saw the turn start, for the live elapsed timer. */
  startedAt: number | null;
  lastMetrics: { messageId: string | null; metrics: ExecutionMetrics } | null;
  /** The latest `task.status` frame a follower saw (v1.12): the task's
   * derived status, queue and pending Decisions, so the document stops
   * polling `/state` while a stream is open. */
  taskStatus: TaskStatusPayload | null;
  /** Tokens in context after the last compaction (v1.12) — the meter reads
   * this over `lastMetrics` until the next execution reports usage. */
  contextTokens: number | null;
  needKey: boolean;
  error: string | null;
  stopped: boolean;
  stalled: boolean;
  failedText: string | null;
};

/** The live-turn slice of a run, for the pure reducers. */
export const liveTurnOf = (run: SessionRun): LiveTurn =>
  ({ items: run.items, answer: run.answer, waiting: run.waiting });

/** A cleared live turn, used whenever a run starts or settles. */
export const CLEAR_TURN = { items: [] as TurnItem[], answer: null, waiting: false, startedAt: null };

const EMPTY: SessionRun = {
  busy: false,
  uploading: false,
  pending: null,
  items: [],
  answer: null,
  waiting: false,
  startedAt: null,
  lastMetrics: null,
  taskStatus: null,
  contextTokens: null,
  needKey: false,
  error: null,
  stopped: false,
  stalled: false,
  failedText: null,
};

const store = new Map<string, SessionRun>();
const listeners = new Map<string, Set<() => void>>();
const indexListeners = new Set<() => void>();
let indexVersion = 0;

// Backend session ids are durable task ids. Deleted ids are never reused, so a
// late write from an aborted execution must not recreate its runtime entry.
const dropped = new Set<string>();
const aborters = new Map<string, () => void>();
const cancellers = new Map<string, () => void>();

function notify(id: string) {
  listeners.get(id)?.forEach((listener) => listener());
  indexVersion += 1;
  indexListeners.forEach((listener) => listener());
}

export function getSessionRun(id: string | null): SessionRun {
  if (!id) return EMPTY;
  return store.get(id) ?? EMPTY;
}

export function patchSessionRun(
  id: string,
  patch: Partial<SessionRun> | ((state: SessionRun) => Partial<SessionRun>),
): void {
  if (dropped.has(id)) return;
  const current = store.get(id) ?? EMPTY;
  const delta = typeof patch === "function" ? patch(current) : patch;
  store.set(id, { ...current, ...delta });
  notify(id);
}

export function registerTurnAbort(id: string, abort: () => void): void {
  aborters.set(id, abort);
}

export function unregisterTurnAbort(id: string, abort: () => void): void {
  if (aborters.get(id) === abort) aborters.delete(id);
}

export function registerTurnCancel(id: string, cancel: () => void): void {
  cancellers.set(id, cancel);
}

export function unregisterTurnCancel(id: string, cancel: () => void): void {
  if (cancellers.get(id) === cancel) cancellers.delete(id);
}

export function dropSessionRun(id: string): void {
  dropped.add(id);
  cancellers.get(id)?.();
  cancellers.delete(id);
  aborters.get(id)?.();
  aborters.delete(id);
  store.delete(id);
  listeners.delete(id);
  notify(id);
}

function subscribe(id: string | null, callback: () => void): () => void {
  if (!id) return () => {};
  let set = listeners.get(id);
  if (!set) {
    set = new Set();
    listeners.set(id, set);
  }
  set.add(callback);
  return () => {
    set!.delete(callback);
    if (set!.size === 0 && listeners.get(id) === set) listeners.delete(id);
  };
}

/** Subscribe to one task's runtime state. */
export function useSessionRun(id: string | null): SessionRun {
  const sub = useCallback((callback: () => void) => subscribe(id, callback), [id]);
  const getSnapshot = useCallback(() => getSessionRun(id), [id]);
  return useSyncExternalStore(sub, getSnapshot);
}

/**
 * Subscribe to the runtime index rather than one task.
 *
 * AgentTaskNavigation uses this so a working row can update while another Task
 * is selected. The monotonically increasing number is intentionally opaque: callers read
 * individual task truth with getSessionRun after React schedules the render.
 */
export function useSessionRunIndexVersion(): number {
  const subscribeIndex = useCallback((callback: () => void) => {
    indexListeners.add(callback);
    return () => indexListeners.delete(callback);
  }, []);
  const snapshot = useCallback(() => indexVersion, []);
  return useSyncExternalStore(subscribeIndex, snapshot);
}
