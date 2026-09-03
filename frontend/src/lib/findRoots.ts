/**
 * Extra find roots beyond the Task document (v1.14): the Artifacts panel
 * registers its body while open so ⌘F covers plans, baselines, and reports —
 * not just the transcript. Same document, so ranges stay comparable.
 */
const roots = new Set<HTMLElement>();

export function registerFindRoot(el: HTMLElement): () => void {
  roots.add(el);
  return () => {
    roots.delete(el);
  };
}

export function getFindRoots(): HTMLElement[] {
  return [...roots];
}

/** Test-only: forget everything. Never called by the app. */
export function resetFindRoots(): void {
  roots.clear();
}
