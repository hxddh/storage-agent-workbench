/**
 * v2.2 — reveal an element by scrolling ONLY its own scroller.
 *
 * `Element.scrollIntoView` scrolls every scrollable ancestor, including the
 * `overflow: hidden` window columns (a hidden overflow is still scrollable by
 * script). Opening a detail row near the end of a Task shifted the whole Task
 * column up and left the Composer floating mid-window over the document. This
 * measures the offset and scrolls the nearest `overflow: auto | scroll`
 * ancestor instead — nothing above it moves.
 */
export type RevealBlock = "nearest" | "start" | "center";

export function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}

export function revealInScroller(el: HTMLElement | null | undefined, block: RevealBlock = "nearest", smooth = true): void {
  if (!el) return;
  const root = scrollerOf(el);
  if (!root) return;
  const box = el.getBoundingClientRect();
  const view = root.getBoundingClientRect();
  let delta = 0;
  if (block === "start") delta = box.top - view.top;
  else if (block === "center") delta = box.top + box.height / 2 - (view.top + view.height / 2);
  else if (box.top < view.top) delta = box.top - view.top;
  else if (box.bottom > view.bottom) delta = Math.min(box.bottom - view.bottom, box.top - view.top);
  if (Math.abs(delta) < 1) return;
  const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (typeof root.scrollBy === "function") root.scrollBy({ top: delta, behavior: smooth && !reduce ? "smooth" : "auto" });
  else root.scrollTop += delta;
}
