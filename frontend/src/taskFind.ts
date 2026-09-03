/**
 * v0.58.0 — find inside one Agent task.
 *
 * The command palette searches task TITLES. Nothing searched the document,
 * so an operator eighty turns into a bucket diagnosis could not get back to
 * the line where the retention rule was named — the one thing a long Task is
 * for. This is the search that was missing.
 *
 * The matching lives here, apart from React, for two reasons: it is the part
 * with rules worth testing (case folding, collapsed turns, ordering), and a
 * Task of several hundred Directions should not re-derive matches inside a
 * render.
 */

export interface TaskFindableItem {
  kind: string;
  id?: string;
  role?: string;
  content?: string | null;
}

export interface FindHit {
  /** DOM id of the task item holding this match. */
  id: string;
  /** How many times the query occurs inside that item. */
  count: number;
  /** Position of the item in the Task, so hits stay in reading order. */
  index: number;
  role?: string;
}

/** The shortest query worth running.
 *
 * v1.15 — Latin text still needs two characters before a search means
 * something (one matches nearly everything). A single CJK character is a
 * complete word (桶/键/账), so it must be searchable: the floor is 1 when
 * the query contains CJK, 2 otherwise. */
export const MIN_QUERY = 2;

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\uff00-\uffef]/;

export function minQueryFor(query: string): number {
  return CJK_RE.test(query.trim()) ? 1 : MIN_QUERY;
}

export function meetsMinQuery(query: string): boolean {
  const q = query.trim();
  if (!q) return false;
  return q.length >= minQueryFor(q);
}

/** Count non-overlapping occurrences of `needle` in `haystack`, case-folded.
 * `indexOf` rather than a RegExp: the query is user text and may contain `(`,
 * `*`, `[` — an object key or an ARN routinely does — and compiling it as a
 * pattern would either throw or silently match the wrong thing. */
export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  let count = 0;
  let from = 0;
  for (;;) {
    const at = h.indexOf(n, from);
    if (at < 0) return count;
    count += 1;
    from = at + n.length;
  }
}

/** Every task item whose text contains the query, in reading order.
 *
 * Only message text is searched. A run card or a triage card is a rendering of
 * structured data the inspector already exposes properly; pretending to search
 * it here would promise more than the result could deliver. */
export function findInTask(items: readonly TaskFindableItem[], query: string): FindHit[] {
  const q = query.trim();
  if (!meetsMinQuery(q)) return [];
  const hits: FindHit[] = [];
  items.forEach((it, index) => {
    if (it.kind !== "message" || !it.id) return;
    const count = countOccurrences(it.content ?? "", q);
    if (count > 0) hits.push({ id: it.id, count, index, role: it.role });
  });
  return hits;
}

/** Total matches across the task — what the "3 / 17" counter shows. */
export function totalMatches(hits: readonly FindHit[]): number {
  return hits.reduce((sum, h) => sum + h.count, 0);
}

/** Move the cursor through the hit list, wrapping at both ends.
 *
 * Wrapping matters more here than in a document find: a Task's
 * earliest mention is usually the one being looked for, and forcing the user to
 * page down through eighty turns to reach it would defeat the feature. Returns
 * 0 for an empty list so callers never index into nothing. */
export function stepHit(current: number, total: number, delta: number): number {
  if (total <= 0) return 0;
  return (((current + delta) % total) + total) % total;
}

/**
 * Split a string on the query so a renderer can mark the matches.
 *
 * Returns alternating segments with a `hit` flag rather than HTML: the Task
 * renders untrusted model and tool text, and building a highlighted string
 * would mean injecting markup into content this product deliberately never
 * treats as markup.
 */
export function highlightSegments(
  text: string,
  query: string,
): Array<{ text: string; hit: boolean }> {
  const q = query.trim();
  if (!meetsMinQuery(q) || !text) return [{ text, hit: false }];
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const out: Array<{ text: string; hit: boolean }> = [];
  let from = 0;
  for (;;) {
    const at = lower.indexOf(needle, from);
    if (at < 0) break;
    if (at > from) out.push({ text: text.slice(from, at), hit: false });
    out.push({ text: text.slice(at, at + needle.length), hit: true });
    from = at + needle.length;
  }
  if (from < text.length) out.push({ text: text.slice(from), hit: false });
  return out.length ? out : [{ text, hit: false }];
}
