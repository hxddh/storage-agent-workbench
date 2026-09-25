/**
 * The turn model (v1.11, Codex parity).
 *
 * A turn is: Direction → [commentary segment | tool rows | steer]* → answer.
 * Live, the items are built from the durable event stream; after the
 * execution settles the persisted message's `turn_items` + `tool_activity` +
 * `content` reproduce the same list. Both feed ONE renderer. (v2.1: nothing
 * pauses a turn for approval, and the model keeps no plan.)
 */
import type { TaskMessage, ToolActivity, ToolProgress, TurnItemRef } from "../types";

/** The runtime compacted the replayed context at this point (v1.12). */
export type CompactedItem = { kind: "compacted"; before_tokens: number | null; after_tokens: number | null };

/** A Steer the running Execution received here (v1.18): the user's
 * Direction mid-turn, rendered as a quiet line — never a tool row. */
export type SteerItem = { kind: "steer"; text: string };

export type TurnItem =
  | { kind: "message"; text: string; live?: boolean }
  | { kind: "tool"; record: ToolActivity }
  | CompactedItem
  | SteerItem;

export type LiveTurn = {
  items: TurnItem[];
  answer: string | null;
};

export const EMPTY_TURN: LiveTurn = { items: [], answer: null };

/** Resolve a streamed tool record against the rows already shown: a
 * "started" row appends, its completed record resolves it in place. */
export function mergeTool(list: ToolActivity[], rec: ToolActivity): ToolActivity[] {
  if (rec.status === "started") return [...list, rec];
  const byId = rec.id ? list.findIndex((a) => a.status === "started" && a.id === rec.id) : -1;
  const i = byId >= 0 ? byId : list.findIndex(
    (a) => a.status === "started" && !a.id && a.tool === rec.tool
      && (!a.target || !rec.target || a.target === rec.target),
  );
  if (i >= 0) {
    const next = list.slice();
    // The completed frame rarely repeats the start stamp; keep the one the
    // started row carried so the group's wall-clock span survives the resolve.
    next[i] = rec.started_at || !list[i].started_at ? rec : { ...rec, started_at: list[i].started_at };
    return next;
  }
  return [...list, rec];
}

function lastLiveIndex(items: TurnItem[]): number {
  // The open segment is the last LIVE message; tool rows may sit after it when their events landed before the segment closed.
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === "message") return item.live ? i : -1;
  }
  return -1;
}

/** Live text of the OPEN segment. */
export function applyDelta(turn: LiveTurn, text: string): LiveTurn {
  if (!text) return turn;
  // The final segment closed the answer: a delta after it is the tail the
  // final `message.completed` already carried, never a new segment.
  if (turn.answer != null) return turn;
  const i = lastLiveIndex(turn.items);
  if (i >= 0) {
    const items = turn.items.slice();
    const current = items[i] as { kind: "message"; text: string; live?: boolean };
    items[i] = { ...current, text: current.text + text };
    return { ...turn, items };
  }
  return { ...turn, items: [...turn.items, { kind: "message", text, live: true }] };
}

/** A closed segment: replace the live text with the sanitized text (unless it
 * was truncated, then keep what streamed). `final` closes the answer. */
export function completeMessage(
  turn: LiveTurn,
  payload: { text: string; final: boolean; truncated?: boolean },
): LiveTurn {
  const i = lastLiveIndex(turn.items);
  const streamed = i >= 0 ? (turn.items[i] as { text: string }).text : "";
  const text = payload.truncated && streamed ? streamed : payload.text;
  const items = turn.items.slice();
  if (payload.final) {
    if (i >= 0) items.splice(i, 1);
    return { ...turn, items, answer: text };
  }
  if (i >= 0) items[i] = { kind: "message", text, live: false };
  else if (text.trim()) items.push({ kind: "message", text, live: false });
  return { ...turn, items };
}

export function applyTool(turn: LiveTurn, rec: ToolActivity): LiveTurn {
  const tools = turn.items.filter((item): item is { kind: "tool"; record: ToolActivity } => item.kind === "tool");
  const list = tools.map((item) => item.record);
  const merged = mergeTool(list, rec);
  if (merged.length === list.length) {
    // Resolved in place: rewrite the tool items in order.
    let k = 0;
    const items = turn.items.map((item) => (item.kind === "tool" ? { kind: "tool" as const, record: merged[k++] } : item));
    return { ...turn, items };
  }
  return { ...turn, items: [...turn.items, { kind: "tool", record: rec }] };
}

/** `tool.progress` (v2.2): the running row with this call id carries the
 * latest counts; a row already resolved (or unknown) is left alone. */
export function applyToolProgress(turn: LiveTurn, id: string, progress: ToolProgress): LiveTurn {
  let changed = false;
  const items = turn.items.map((item) => {
    if (item.kind !== "tool" || item.record.id !== id || item.record.status !== "started") return item;
    changed = true;
    return { kind: "tool" as const, record: { ...item.record, progress } };
  });
  return changed ? { ...turn, items } : turn;
}

/** `context.compacted` (v1.12): one quiet marker at the current position —
 * the top of the turn when the runtime compacted before its model loop. */
export function applyCompacted(
  turn: LiveTurn,
  payload: { before_tokens: number | null; after_tokens: number | null },
): LiveTurn {
  const marker: CompactedItem = {
    kind: "compacted", before_tokens: payload.before_tokens ?? null, after_tokens: payload.after_tokens ?? null,
  };
  return { ...turn, items: [...turn.items, marker] };
}

/** `steer.applied`: the Direction lands at the current position. */
export function applySteer(turn: LiveTurn, text: string): LiveTurn {
  const trimmed = text.trim();
  if (!trimmed) return turn;
  return { ...turn, items: [...turn.items, { kind: "steer", text: trimmed }] };
}

/**
 * The durable projection: the persisted message's ordered `turn_items` with
 * tool references resolved against `tool_activity`. A pre-1.11 row (no items)
 * renders its tool rows as one group before the answer.
 */
export function turnItemsOf(message: Pick<TaskMessage, "turn_items" | "tool_activity">): TurnItem[] {
  const activity = message.tool_activity ?? [];
  const refs: TurnItemRef[] = message.turn_items ?? [];
  const byId = new Map<string, ToolActivity>();
  for (const record of activity) if (record.id) byId.set(record.id, record);
  const items: TurnItem[] = [];
  const seen = new Set<string>();
  const pushTool = (record: ToolActivity) => {
    items.push({ kind: "tool", record });
    if (record.id) seen.add(record.id);
  };
  for (const ref of refs) {
    if (ref.kind === "message") {
      if (ref.text.trim()) items.push({ kind: "message", text: ref.text });
    } else if (ref.kind === "tool") {
      const record = byId.get(ref.id);
      if (record && !seen.has(ref.id)) pushTool(record);
    } else if (ref.kind === "compacted") {
      items.push({ kind: "compacted", before_tokens: ref.before_tokens ?? null, after_tokens: ref.after_tokens ?? null });
    } else if (ref.kind === "steer") {
      if (ref.text?.trim()) items.push({ kind: "steer", text: ref.text.trim() });
    }
  }
  // Tool rows the item list did not reference (pre-1.11 rows, or a call the
  // runtime recorded after its last segment) still belong to the turn.
  for (const record of activity) {
    if (record.tool === "user_steer") continue; // pre-1.18 steer notice, not a tool
    if (record.id && seen.has(record.id)) continue;
    if (!record.id && refs.length > 0) continue;
    pushTool(record);
  }
  return items;
}

/** Split a turn's items into renderable segments: consecutive tool rows fold
 * into ONE worked group; commentary stays in order. */
export type TurnSegment =
  | { kind: "commentary"; text: string; live: boolean }
  | { kind: "worked"; records: ToolActivity[] }
  | CompactedItem
  | SteerItem;

export function segmentsOf(items: TurnItem[]): TurnSegment[] {
  const out: TurnSegment[] = [];
  for (const item of items) {
    if (item.kind === "tool") {
      if (item.record.tool === "user_steer") {
        // A pre-1.18 live row: the Steer, not a tool call.
        if (item.record.result?.trim()) out.push({ kind: "steer", text: item.record.result.trim() });
        continue;
      }
      const last = out[out.length - 1];
      if (last && last.kind === "worked") last.records = [...last.records, item.record];
      else out.push({ kind: "worked", records: [item.record] });
    } else if (item.kind === "message") {
      if (item.text.trim() || item.live) out.push({ kind: "commentary", text: item.text, live: item.live === true });
    } else {
      out.push(item);
    }
  }
  return out;
}
