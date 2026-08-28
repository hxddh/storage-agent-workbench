import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  cleanError,
  looksLikeError,
  mergeTool,
  useTurnRunner as useTurnRunnerImplementation,
} from "./useTurnRunnerImplementation";

export { cleanError, looksLikeError, mergeTool };

export type TurnRunnerOptions = Parameters<typeof useTurnRunnerImplementation>[0];
export type TurnController = ReturnType<typeof useTurnRunnerImplementation>;

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
 * The large proven implementation remains byte-for-byte behind this module for
 * now. The wrapper publishes a stable semantic controller to the Agent OS shell;
 * the proxy forwards to the latest implementation callbacks so streaming renders
 * do not cause controller identity churn across the workbench.
 */
export function useTurnRunner(opts: TurnRunnerOptions): TurnController {
  const implementation = useTurnRunnerImplementation(opts);
  const latest = useRef(implementation);
  latest.current = implementation;

  const controller = useMemo<TurnController>(() => ({
    submit: (text) => latest.current.submit(text),
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
