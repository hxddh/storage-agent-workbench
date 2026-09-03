import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The one clipboard path (v1.14): async Clipboard API with an execCommand
 * fallback, replacing four hand-rolled copies across the transcript, code
 * blocks, error artifacts, and call detail. Behaviour is unchanged on
 * purpose — only the duplication is gone.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  const fallback = (): boolean => {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  };
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return fallback();
    }
  }
  return fallback();
}

/** Button-friendly copy state: `copied` resets after a beat. */
export function useCopy(resetMs = 1400): { copied: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const copy = useCallback(
    (text: string) => {
      void copyTextToClipboard(text).then((ok) => {
        if (!ok) return;
        setCopied(true);
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), resetMs);
      });
    },
    [resetMs],
  );
  return { copied, copy };
}
