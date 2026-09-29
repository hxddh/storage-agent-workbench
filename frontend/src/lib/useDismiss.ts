import { useEffect, useRef } from "react";

/** A menu closes when the pointer goes down anywhere outside it (its trigger included in `ref`). */
export function useDismiss<T extends HTMLElement>(open: boolean, close: () => void) {
  const ref = useRef<T>(null);
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) latest.current(); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  return ref;
}
