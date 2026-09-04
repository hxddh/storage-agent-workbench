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

type QueuedDirection = { id: string; direction?: string | null };

/**
 * Queued banners are only Directions waiting *behind* the current Execution.
 *
 * The Sidecar inserts every submit as `queued` and `task.status.queued[]`
 * can name the execution the client is already following. GET `/agent-tasks`
 * already drops that row; the live Direction bubble paints it. Painting it
 * again as a "Queued" user bubble is the mysterious duplicate.
 */
export function visibleQueuedExecutions<T extends QueuedDirection>(
  queued: T[],
  opts: {
    activeExecutionId?: string | null;
    livePending?: string | null;
    hideLiveDirection?: boolean;
  },
): T[] {
  const pending = (opts.livePending ?? "").trim();
  const activeId = opts.activeExecutionId ?? "";
  const liveBubbleShowsPending = Boolean(pending) && !opts.hideLiveDirection;
  return queued.filter((row) => {
    if (activeId && row.id === activeId) return false;
    // Before the follower knows the active id, the just-submitted row still
    // sits in queued[] with the same text as the live (or just-persisted)
    // Direction. A later queued-behind Direction with the same wording is
    // distinguishable only once we have an active id.
    if (!activeId && pending && (row.direction ?? "").trim() === pending) {
      if (liveBubbleShowsPending || opts.hideLiveDirection) return false;
    }
    return true;
  });
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
