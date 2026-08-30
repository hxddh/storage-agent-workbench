/** Timeline rows that can sit between Directions without being the current turn. */
type TimelineItem = {
  kind: string;
  role?: string;
  content?: string | null;
};

/**
 * True only when the latest persisted message is this live Direction.
 *
 * History-wide matching is wrong: re-delegating the same text as an earlier
 * Direction would hide the new execution's stream. Skip run/triage rows so a
 * trailing Execution link cannot mask the current user message.
 */
export function isCurrentPersistedDirection(
  items: TimelineItem[],
  pending: string | null | undefined,
): boolean {
  if (!pending) return false;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item.kind !== "message") continue;
    return item.role === "user" && (item.content ?? "") === pending;
  }
  return false;
}

/** Settled-race cleanup: any persisted user message already holds this Direction. */
export function pendingMatchesPersistedDirection(
  items: TimelineItem[],
  pending: string | null | undefined,
): boolean {
  if (!pending) return false;
  return items.some(
    (item) => item.kind === "message" && item.role === "user" && (item.content ?? "") === pending,
  );
}
