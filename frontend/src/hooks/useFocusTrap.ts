import { useEffect, useRef } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * Keep keyboard focus inside an open overlay, and give it back when it closes.
 *
 * Without this, Tab walks straight out of a modal into the page behind it: you
 * end up typing into a composer you cannot see, under a scrim that says the app
 * is busy with something else. Closing then leaves focus wherever it drifted,
 * so the next keystroke goes somewhere arbitrary.
 *
 * Returns a ref to put on the overlay's container element.
 */
export function useFocusTrap<T extends HTMLElement>(active: boolean) {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    if (!active) return;
    const node = ref.current;
    if (!node) return;

    // Remember where focus came from so we can hand it back on close — the
    // button that opened the overlay, usually.
    const restoreTo = document.activeElement as HTMLElement | null;

    const focusables = () =>
      Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((el) => el.offsetParent !== null || el === document.activeElement);

    // Move focus in, unless the overlay already claimed it (e.g. a search input
    // that autofocuses — stealing it back would be worse than not helping).
    if (!node.contains(document.activeElement)) {
      const first = focusables()[0];
      (first ?? node).focus?.();
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      // Wrap at both ends. Focus that has escaped entirely (or sits on the
      // container) is pulled back to the appropriate edge.
      if (e.shiftKey) {
        if (current === first || !node.contains(current)) {
          e.preventDefault();
          last.focus();
        }
      } else if (current === last || !node.contains(current)) {
        e.preventDefault();
        first.focus();
      }
    };

    node.addEventListener("keydown", onKeyDown);
    return () => {
      node.removeEventListener("keydown", onKeyDown);
      // Only restore if focus is still inside the closing overlay; if the user
      // already clicked elsewhere, yanking it back would be the rude option.
      if (!node.contains(document.activeElement) && document.activeElement !== document.body) return;
      restoreTo?.focus?.();
    };
  }, [active]);

  return ref;
}
