import { useSyncExternalStore } from "react";

/**
 * How much agent process is kept open in the conversation.
 *
 * This is intentionally a product preference rather than a per-session field:
 * it describes how the reader wants to consume agent work, not anything about
 * the investigation itself. Cursor 3.4 uses the same three-level model for tool
 * activity. The semantics here are storage-workbench specific:
 *
 * - compact: answer first; every finished trace starts folded.
 * - balanced: the turn you just watched stays open; history folds.
 * - detailed: finished traces stay open throughout the investigation.
 *
 * Explicitly opening/closing one turn still wins for that turn. Density controls
 * the default, never removes evidence or makes a call inaccessible.
 */
export type ActivityDensity = "compact" | "balanced" | "detailed";

export const ACTIVITY_DENSITIES: ReadonlyArray<{
  value: ActivityDensity;
  label: string;
  description: string;
}> = [
  {
    value: "compact",
    label: "Compact",
    description: "Results first · tool traces stay folded",
  },
  {
    value: "balanced",
    label: "Balanced",
    description: "Keep the newest turn's important steps visible",
  },
  {
    value: "detailed",
    label: "Detailed",
    description: "Keep finished tool traces visible across the thread",
  },
];

const KEY = "saw.activityDensity";
const VALID = new Set<ActivityDensity>(["compact", "balanced", "detailed"]);

function readStored(): ActivityDensity {
  if (typeof window === "undefined") return "balanced";
  const raw = window.localStorage.getItem(KEY) as ActivityDensity | null;
  return raw && VALID.has(raw) ? raw : "balanced";
}

let current: ActivityDensity = readStored();
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

// Keep separate windows/webviews coherent. The same-window setter below emits
// directly because the browser's `storage` event intentionally does not fire in
// the document that performed the write.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== KEY) return;
    const next = readStored();
    if (next === current) return;
    current = next;
    emit();
  });
}

export function getActivityDensity(): ActivityDensity {
  return current;
}

export function setActivityDensity(next: ActivityDensity) {
  if (!VALID.has(next) || next === current) return;
  current = next;
  if (typeof window !== "undefined") window.localStorage.setItem(KEY, next);
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useActivityDensity(): ActivityDensity {
  return useSyncExternalStore(subscribe, getActivityDensity, () => "balanced");
}

/** The default disclosure rule. Kept pure so the behaviour is unit-testable. */
export function defaultTraceOpen(density: ActivityDensity, latest: boolean): boolean {
  if (density === "compact") return false;
  if (density === "detailed") return true;
  return latest;
}
