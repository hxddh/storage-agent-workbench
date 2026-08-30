import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
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

export function useActiveTurnController(): TurnController | null {
  return useSyncExternalStore(subscribeController, controllerSnapshot, controllerSnapshot);
}

export function useTurnRunner(opts: TurnRunnerOptions): TurnController {
  const implementation = useTurnRunnerImplementation(opts);
  const latest = useRef(implementation);
  latest.current = implementation;
  const options = useRef(opts);
  options.current = opts;

  const controller = useMemo<TurnController>(() => ({
    submit: (text) => latest.current.submit(text),
    submitToSession: async (sessionId, text) => {
      const localId = options.current.localId;
      const previous = localId.current;
      localId.current = sessionId;
      try {
        await latest.current.submit(text);
        const finished = getSessionRun(sessionId);
        if (!finished.error && !finished.needKey && localId.current === sessionId) {
          await options.current.reload(sessionId);
        }
      } finally {
        if (localId.current === sessionId && previous !== sessionId) {
          localId.current = previous;
        }
      }
    },
    submitWithDataset: (message, file, type) => latest.current.submitWithDataset(message, file, type),
    stop: (sessionId) => latest.current.stop(sessionId),
    steer: (text, resend) => latest.current.steer(text, resend),
    resume: (executionId) => latest.current.resume(executionId),
    verify: () => latest.current.verify(),
    followExecution: (executionId, direction) => latest.current.followExecution(executionId, direction),
  }), []);

  useEffect(() => {
    publishController(controller);
    return () => {
      if (activeController === controller) publishController(null);
    };
  }, [controller]);

  return controller;
}
