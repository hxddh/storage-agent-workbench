import { useCallback, useEffect, useRef, useState } from "react";

const AUTOSCROLL_FRAME_BUDGET = 90;
const AUTOSCROLL_SETTLED_FRAMES = 3;

/**
 * Own the Timeline's reading viewport independently from session/transport state.
 *
 * The important contract is intent: a real wheel/touch gesture releases the
 * reader from follow mode immediately; programmatic convergence never pretends
 * to be user input; jump-to-latest keeps correcting while streamed/document
 * layout is still discovering its final height.
 */
export function useThreadViewport() {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);
  const autoScrollRef = useRef<number | null>(null);
  const autoBudgetRef = useRef(0);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || autoScrollRef.current !== null) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    pinnedRef.current = atBottom;
    setPinned((previous) => (previous === atBottom ? previous : atBottom));
  }, []);

  const stopAutoScroll = useCallback(() => {
    if (autoScrollRef.current !== null) cancelAnimationFrame(autoScrollRef.current);
    autoScrollRef.current = null;
    autoBudgetRef.current = 0;
  }, []);

  const scrollToBottom = useCallback(() => {
    if (!scrollRef.current) return;
    autoBudgetRef.current = AUTOSCROLL_FRAME_BUDGET;
    if (autoScrollRef.current !== null) return;

    let previousHeight = -1;
    let stableFrames = 0;
    const step = () => {
      const node = scrollRef.current;
      if (!node) {
        autoScrollRef.current = null;
        return;
      }
      node.scrollTop = node.scrollHeight;
      stableFrames = node.scrollHeight === previousHeight ? stableFrames + 1 : 0;
      previousHeight = node.scrollHeight;
      if (stableFrames >= AUTOSCROLL_SETTLED_FRAMES || --autoBudgetRef.current <= 0) {
        autoScrollRef.current = null;
        pinnedRef.current = true;
        setPinned(true);
        return;
      }
      autoScrollRef.current = requestAnimationFrame(step);
    };
    autoScrollRef.current = requestAnimationFrame(step);
  }, []);

  const releaseToUser = useCallback(() => stopAutoScroll(), [stopAutoScroll]);

  const jumpToLatest = useCallback(() => {
    pinnedRef.current = true;
    setPinned(true);
    scrollToBottom();
  }, [scrollToBottom]);

  const resetPinned = useCallback(() => {
    pinnedRef.current = true;
    setPinned(true);
  }, []);

  const followLatest = useCallback(() => {
    if (pinnedRef.current) scrollToBottom();
  }, [scrollToBottom]);

  useEffect(() => stopAutoScroll, [stopAutoScroll]);

  return {
    scrollRef,
    contentRef,
    pinned,
    pinnedRef,
    onScroll,
    releaseToUser,
    scrollToBottom,
    jumpToLatest,
    resetPinned,
    followLatest,
  };
}
