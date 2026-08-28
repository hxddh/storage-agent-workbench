import { useEffect, useRef } from "react";
import { pushOverlay } from "../lib/overlayStack";

/**
 * Let Escape close this overlay — but only while it is the topmost one.
 *
 * Replaces a per-component `window.addEventListener("keydown", …)`. Those all
 * fired at once, so one Escape closed every overlay that happened to be open.
 * See `lib/overlayStack.ts`.
 */
export function useDismissOnEscape(active: boolean, onClose: () => void): void {
  // A ref so a fresh `onClose` on every render does not re-register the
  // overlay, which would quietly move it to the top of the stack each time.
  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => {
    if (!active) return;
    return pushOverlay(() => latest.current());
  }, [active]);
}
