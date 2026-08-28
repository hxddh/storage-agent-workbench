/**
 * Mark what you searched for, in the text where it is.
 *
 * Find reported "1 / 29" and marked nothing. Worse, the two halves of that
 * counter were counting different things: the total was every OCCURRENCE in the
 * thread, while stepping moved between MESSAGES that contained at least one. So
 * an answer with twelve mentions of `bucket-003` was one stop out of eight, the
 * counter promised twenty-nine, and next/previous wrapped long before reaching
 * the number it displayed. Then it scrolled a two-thousand-word answer into view
 * and left the reader to find the word by eye.
 *
 * This walks the rendered text and produces one Range per occurrence, which is
 * the unit the counter was already claiming to use.
 *
 * Painting them uses the CSS Custom Highlight API: no DOM is rewritten, so a
 * streaming answer, a React re-render and the thread's own scroll maths are all
 * untouched by searching — which the alternative, wrapping matches in <mark>
 * elements, cannot say. Where the API is missing the ranges are still computed
 * and still scrolled to; only the paint is skipped.
 */

const NAME = "saw-find";
const ACTIVE = "saw-find-active";

type HighlightCtor = new (...ranges: Range[]) => unknown;
type HighlightRegistry = { set(name: string, value: unknown): void; delete(name: string): void };

function registry(): HighlightRegistry | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const Ctor = (globalThis as { Highlight?: HighlightCtor }).Highlight;
  return css?.highlights && Ctor ? css.highlights : null;
}

/**
 * Skip text that is not part of the answer: script, style, the find bar — and
 * anything on screen only for a screen reader.
 *
 * That last one is not hypothetical. Every answer carries an `sr-only` "Storage
 * Agent" label (the visible name was replaced by the gutter mark), so a search
 * for "storage" counted one hit per answer that no reader could ever see, and
 * next/previous stopped on a zero-sized range at the top of each turn.
 */
function skip(node: Node): boolean {
  const el = node.parentElement;
  if (!el) return true;
  if (el.closest("script,style,noscript")) return true;
  if (el.closest("[data-find-skip]")) return true;
  if (el.closest(".sr-only,[hidden],[aria-hidden='true']")) return true;
  return false;
}

/**
 * One Range per occurrence of `query` under `root`, in document order.
 *
 * Case-insensitive, like every find bar. Matches are found per text node, so a
 * term split across an element boundary (`bucket-<em>003</em>`) is not found —
 * an accepted limit: markdown emphasis inside an identifier is vanishingly rare
 * here, and stitching nodes together would mean rebuilding the text layer.
 */
export function findRanges(root: Node, query: string): Range[] {
  const q = query.trim().toLowerCase();
  const out: Range[] = [];
  if (q.length === 0) return out;

  const doc = (root.ownerDocument ?? (root as Document)) as Document;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (!skip(node)) {
      const text = (node.nodeValue ?? "").toLowerCase();
      let from = text.indexOf(q);
      while (from !== -1) {
        const range = doc.createRange();
        range.setStart(node, from);
        range.setEnd(node, from + q.length);
        out.push(range);
        from = text.indexOf(q, from + q.length);
      }
    }
    node = walker.nextNode();
  }
  return out;
}

/**
 * Paint the ranges, with `activeIndex` picked out from the rest.
 *
 * Returns false when the browser has no Highlight API — the caller still has
 * usable ranges to scroll to, so find keeps working, just unpainted.
 */
export function paintFind(ranges: readonly Range[], activeIndex: number): boolean {
  const reg = registry();
  if (!reg) return false;
  const Ctor = (globalThis as unknown as { Highlight: HighlightCtor }).Highlight;
  const rest = ranges.filter((_, i) => i !== activeIndex);
  reg.set(NAME, new Ctor(...rest));
  const active = ranges[activeIndex];
  reg.set(ACTIVE, active ? new Ctor(active) : new Ctor());
  return true;
}

/** Stop painting. Safe to call when nothing was ever painted. */
export function clearFind(): void {
  const reg = registry();
  if (!reg) return;
  reg.delete(NAME);
  reg.delete(ACTIVE);
}
