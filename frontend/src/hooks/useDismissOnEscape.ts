import { useEffect, useRef } from "react";
import { pushOverlay } from "../lib/overlayStack";
import { isEditable } from "../shortcuts";

/**
 * Let Escape close this overlay — but only while it is the topmost one.
 *
 * Replaces a per-component `window.addEventListener("keydown", …)`. Those all
 * fired at once, so one Escape closed every overlay that happened to be open.
 * See `lib/overlayStack.ts`.
 */
export function useDismissOnEscape(
  active: boolean,
  onClose: () => void,
  opts?: {
    /**
     * Ignore an Escape typed inside a field, instead of closing.
     *
     * For an overlay that is a FORM: a half-entered endpoint — or a secret key,
     * which cannot be read back once typed — must not be thrown away by the key
     * people press to dismiss autocomplete, or by a zh/ja/ko user's habitual
     * IME cancel. Overlays whose field IS the overlay (the command palette)
     * leave this off: there, Escape in the input is the way out.
     */
    ignoreInFields?: boolean;
  },
): void {
  // A ref so a fresh `onClose` on every render does not re-register the
  // overlay, which would quietly move it to the top of the stack each time.
  const latest = useRef(onClose);
  latest.current = onClose;
  const ignoreInFields = opts?.ignoreInFields ?? false;
  useEffect(() => {
    if (!active) return;
    return pushOverlay(() => {
      if (ignoreInFields && isEditable(document.activeElement)) return;
      latest.current();
    });
  }, [active, ignoreInFields]);
}
