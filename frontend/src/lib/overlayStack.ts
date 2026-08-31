/**
 * Which overlay does Escape close? The one on top, and only that one.
 *
 * Five window-level Escape handlers had grown up independently — the shortcuts
 * sheet, the session inspector, the run overlay, the import dialog, and a
 * catch-all in `App` that closed the palette, the settings drawer and the sheet
 * together. Each one is correct alone. Stacked, they are not: with the session
 * inspector open, opening the command palette and pressing Escape once closed
 * BOTH, so dismissing the thing you had just opened also threw away the thing
 * you opened it from. Measured, not assumed — a probe reported
 * `{palette: 0, inspector: 0}` after a single Escape.
 *
 * A stack fixes it without a component knowing about any other: whoever mounted
 * last is on top, Escape asks only them, and unmounting removes them wherever
 * they sit. Deliberately a plain module rather than context — the handler has to
 * be reachable from one window listener, and a provider would only add a tree
 * the overlays do not otherwise need.
 *
 * NOT for Escape handlers bound to a focused input (the find bar, the task
 * rename box). Those already only fire when that
 * element has focus, which is its own, correct, scoping.
 */
type Close = () => void;

const stack: Close[] = [];

/** Register an open overlay. Returns the unregister function for cleanup. */
export function pushOverlay(close: Close): () => void {
  stack.push(close);
  return () => {
    const i = stack.lastIndexOf(close);
    if (i >= 0) stack.splice(i, 1);
  };
}

/** Close the topmost overlay. Returns false when there was nothing to close. */
export function closeTopOverlay(): boolean {
  const close = stack[stack.length - 1];
  if (!close) return false;
  close();
  return true;
}

/** How many overlays are open. Exported for tests. */
export function overlayDepth(): number {
  return stack.length;
}

/** Test-only: forget everything. Never called by the app. */
export function resetOverlayStack(): void {
  stack.length = 0;
}
