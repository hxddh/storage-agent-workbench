import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { IconButton } from "./ui";

/**
 * One notification surface for the whole app: failures of an action the user
 * took. An error never auto-dismisses — a failure the user blinked past is a
 * failure they will hit again.
 */

interface Toast {
  id: number;
  message: string;
}

interface ToastApi {
  error: (message: string) => void;
}

const Ctx = createContext<ToastApi | null>(null);

/** Cap the stack so a failing loop can't paper over the app. */
const MAX_VISIBLE = 4;

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);
  const api = useMemo<ToastApi>(() => ({
    error: (message) => setToasts((list) => [...list, { id: nextId++, message }].slice(-MAX_VISIBLE)),
  }), []);
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

function ToastViewport({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div
      // Polite, not assertive: important, but never interrupting speech.
      role="status"
      aria-live="polite"
      data-testid="toast-viewport"
      className="pointer-events-none fixed bottom-4 right-4 z-toast flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2"
    >
      {toasts.map((t) => (
        <div key={t.id} data-kind="error" className="toast-card animate-scale-in">
          <span className="toast-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <circle cx="12" cy="12" r="9" /><line x1="12" y1="8" x2="12" y2="13" /><line x1="12" y1="16.5" x2="12" y2="16.5" />
            </svg>
          </span>
          <span className="toast-message">{t.message}</span>
          <IconButton icon="close" label="Dismiss" size="sm" onClick={() => onDismiss(t.id)} />
        </div>
      ))}
    </div>
  );
}
