import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/**
 * One notification surface for the whole app.
 *
 * Before this there were two: a hand-rolled fixed bar in App.tsx for action
 * failures and inline banners in the Task — different shapes, different
 * placement, neither dismissible on its own. Two presentations of "something
 * went wrong" teach the user nothing consistent.
 *
 * Errors do NOT auto-dismiss: a failure the user blinked past is a failure they
 * will hit again. Successes do.
 */

export type ToastKind = "error" | "success" | "info";

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  /** One optional inline action (retry, undo, open settings). */
  action?: { label: string; run: () => void };
}

interface ToastApi {
  push: (t: Omit<Toast, "id">) => number;
  dismiss: (id: number) => void;
  error: (message: string, action?: Toast["action"]) => number;
  success: (message: string) => number;
  info: (message: string) => number;
}

const Ctx = createContext<ToastApi | null>(null);

/** Auto-dismiss delay per kind. `null` = stays until dismissed. */
const TTL: Record<ToastKind, number | null> = {
  error: null,
  success: 3200,
  info: 5000,
};

/** Cap the stack so a failing loop can't paper over the app. */
const MAX_VISIBLE = 4;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = nextId.current++;
    setToasts((list) => [...list, { ...t, id }].slice(-MAX_VISIBLE));
    const ttl = TTL[t.kind];
    if (ttl != null) {
      timers.current.set(id, setTimeout(() => dismiss(id), ttl));
    }
    return id;
  }, [dismiss]);

  // Every pending timer is cleared on unmount — a fired timeout on a dead
  // component is a React state-update warning and a leak.
  useEffect(() => () => {
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
  }, []);

  const api = useMemo<ToastApi>(() => ({
    push,
    dismiss,
    error: (message, action) => push({ kind: "error", message, action }),
    success: (message) => push({ kind: "success", message }),
    info: (message) => push({ kind: "info", message }),
  }), [push, dismiss]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(Ctx);
  if (!api) throw new Error("useToast must be used inside <ToastProvider>");
  return api;
}

const TONE: Record<ToastKind, { border: string; icon: ReactNode; text: string }> = {
  error: {
    border: "border-danger-border",
    text: "text-danger",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
        <circle cx="12" cy="12" r="9" /><line x1="12" y1="8" x2="12" y2="13" /><line x1="12" y1="16.5" x2="12" y2="16.5" />
      </svg>
    ),
  },
  success: {
    border: "border-success-border",
    text: "text-success",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <polyline points="20 6 9 17 4 12" />
      </svg>
    ),
  },
  info: {
    border: "border-edge-strong",
    text: "text-gray-200",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
        <circle cx="12" cy="12" r="9" /><line x1="12" y1="11" x2="12" y2="16" /><line x1="12" y1="7.5" x2="12" y2="7.5" />
      </svg>
    ),
  },
};

function ToastViewport({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div
      // Polite, not assertive: these announce a failure or a completed action
      // the user is waiting on — important, but never interrupting speech.
      role="status"
      aria-live="polite"
      data-testid="toast-viewport"
      className="pointer-events-none fixed bottom-4 right-4 z-toast flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2"
    >
      {toasts.map((t) => {
        const tone = TONE[t.kind];
        return (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-start gap-2.5 rounded-xl border ${tone.border} bg-panel px-3.5 py-2.5 shadow-pop animate-scale-in`}
          >
            <span className={`mt-px shrink-0 ${tone.text}`}>{tone.icon}</span>
            <span className="min-w-0 flex-1 break-words text-xs leading-relaxed text-gray-200">{t.message}</span>
            {t.action && (
              <button
                onClick={() => { t.action?.run(); onDismiss(t.id); }}
                className="shrink-0 text-xs font-medium text-gray-100 underline underline-offset-2 transition-[color] duration-fast hover:text-gray-300"
              >
                {t.action.label}
              </button>
            )}
            <button
              onClick={() => onDismiss(t.id)}
              aria-label="Dismiss"
              className="-mr-1 shrink-0 rounded p-0.5 text-gray-500 transition-[color] duration-fast hover:text-gray-200"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}
