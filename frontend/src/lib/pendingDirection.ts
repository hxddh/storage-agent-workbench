/** Task document rows that can sit between Directions without being the current turn. */
type TaskDocumentItem = {
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
  items: TaskDocumentItem[],
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
  items: TaskDocumentItem[],
  pending: string | null | undefined,
): boolean {
  if (!pending) return false;
  return items.some(
    (item) => item.kind === "message" && item.role === "user" && (item.content ?? "") === pending,
  );
}

/**
 * True when the current turn already has a persisted Work Result.
 *
 * Pair the latest assistant message with the Direction immediately before it.
 * History-wide matching would hide a new stream that reuses earlier wording.
 * Skip run/triage rows so a trailing Execution link cannot mask that pair.
 */
export function isCurrentPersistedWorkResult(
  items: TaskDocumentItem[],
  pending: string | null | undefined,
): boolean {
  if (!pending) return false;
  let sawAssistant = false;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item.kind !== "message") continue;
    if (!sawAssistant) {
      if (item.role !== "assistant") return false;
      sawAssistant = true;
      continue;
    }
    return item.role === "user" && (item.content ?? "") === pending;
  }
  return false;
}

/**
 * Queued executions the Task should paint as queued.
 *
 * A Direction delegated to an idle task is briefly `queued` before the
 * supervisor starts it; the live pending heading already IS that Direction,
 * so painting it again as a queued row would show the same words twice.
 * Only the head of the queue with nothing running ahead of it can be the
 * live Direction; anything behind a running execution is genuinely queued.
 */
export function visibleQueuedExecutions<T extends { direction: string | null }>(
  queued: T[],
  pending: string | null | undefined,
  hasActiveExecution: boolean,
): T[] {
  if (!pending || hasActiveExecution || queued.length === 0) return queued;
  return queued[0].direction === pending ? queued.slice(1) : queued;
}
