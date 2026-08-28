import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { getSession } from "../api";
import { getSessionRun } from "../sessionRuns";
import {
  cleanError,
  looksLikeError,
  mergeTool,
  useTurnRunner as useTurnRunnerImplementation,
} from "./useTurnRunnerImplementation";

export { cleanError, looksLikeError, mergeTool };

export type TurnRunnerOptions = Parameters<typeof useTurnRunnerImplementation>[0];
type ImplementationController = ReturnType<typeof useTurnRunnerImplementation>;

export type TurnController = ImplementationController & {
  /**
   * Submit a normal turn to an explicit investigation.
   *
   * Deep Work Surfaces (Evidence / Runs / Report) must never depend on the
   * hidden Timeline's mutable `localId.current`. The Workbench already knows
   * which investigation it is displaying, so it passes that id explicitly.
   * Resolution also means the durable investigation document has observed the
   * new assistant message, not merely that the model stream emitted its answer.
   */
  submitToSession: (sessionId: string, text: string) => Promise<void>;
};

let activeController: TurnController | null = null;
const controllerListeners = new Set<() => void>();

function publishController(next: TurnController | null) {
  if (activeController === next) return;
  activeController = next;
  controllerListeners.forEach((listener) => listener());
}

function subscribeController(listener: () => void) {
  controllerListeners.add(listener);
  return () => controllerListeners.delete(listener);
}

function controllerSnapshot() {
  return activeController;
}

const settleDelay = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

async function assistantIds(sessionId: string): Promise<Set<string> | null> {
  try {
    const detail = await getSession(sessionId);
    return new Set(detail.messages.filter((message) => message.role === "assistant").map((message) => message.id));
  } catch {
    return null;
  }
}

/**
 * Read the semantic controller owned by the currently mounted Timeline.
 *
 * v0.92 keeps one real turn lifecycle while the Timeline implementation is being
 * decomposed. Evidence / Runs / Report can therefore steer the same in-flight
 * turn instead of creating a second runner, duplicating AbortControllers or
 * dispatching through DOM events.
 */
export function useActiveTurnController(): TurnController | null {
  return useSyncExternalStore(subscribeController, controllerSnapshot, controllerSnapshot);
}

/**
 * Public turn-runner boundary.
 *
 * The large proven implementation remains behind this module for now. The
 * wrapper publishes a stable semantic controller to the Agent OS shell; the
 * proxy forwards to the latest implementation callbacks so streaming renders
 * do not cause controller identity churn across the workbench.
 */
export function useTurnRunner(opts: TurnRunnerOptions): TurnController {
  const implementation = useTurnRunnerImplementation(opts);
  const latest = useRef(implementation);
  latest.current = implementation;
  const options = useRef(opts);
  options.current = opts;

  const controller = useMemo<TurnController>(() => ({
    submit: (text) => latest.current.submit(text),
    submitToSession: async (sessionId, text) => {
      // The implementation intentionally owns a single mutable session pointer.
      // Timeline keeps that pointer synchronized while it is the visible surface,
      // but deep Work Surfaces can submit while Timeline is not the interaction
      // owner. Pin the pointer to the Workbench's explicit investigation for the
      // whole turn so acquireSubmit / runTurn / reload all target the same session.
      const localId = options.current.localId;
      const previous = localId.current;
      const before = await assistantIds(sessionId);
      localId.current = sessionId;
      try {
        await latest.current.submit(text);

        // The model stream's SSE `done` event and the durable session document
        // are two different boundaries. A successful stream can finish a few
        // milliseconds before its assistant message becomes visible to GET
        // /sessions/:id. Timeline's normal submit path already reloads once, but
        // a deep Work Surface can expose that tiny window by navigating back to
        // Timeline immediately after the live answer appears. Confirm the new
        // assistant message, then refresh the document once more before this
        // semantic operation is considered settled.
        const finished = getSessionRun(sessionId);
        if (!finished.error && !finished.needKey && !finished.stalled && before) {
          for (const delay of [0, 50, 100, 200, 400, 800, 1600]) {
            if (delay) await settleDelay(delay);
            const after = await assistantIds(sessionId);
            if (after && [...after].some((id) => !before.has(id))) {
              if (localId.current === sessionId) await options.current.reload(sessionId);
              break;
            }
          }
        }
      } finally {
        // Do not overwrite a legitimate navigation/session transition that may
        // have happened while the async turn was settling.
        if (localId.current === sessionId && previous !== sessionId) {
          localId.current = previous;
        }
      }
    },
    submitWithDataset: (message, file, type) => latest.current.submitWithDataset(message, file, type),
    stop: (sessionId) => latest.current.stop(sessionId),
    steer: (text, resend) => latest.current.steer(text, resend),
  }), []);

  useEffect(() => {
    publishController(controller);
    return () => {
      if (activeController === controller) publishController(null);
    };
  }, [controller]);

  return controller;
}