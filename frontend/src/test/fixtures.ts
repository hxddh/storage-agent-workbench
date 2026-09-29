import type { Item, TaskSnapshot, Turn } from "../api/types";

let seq = 0;
export function resetSeq() { seq = 0; }

export function turn(id: string, over: Partial<Turn> = {}): Turn {
  return { id, parent_turn_id: null, kind: "direction", direction: `Direction ${id}`, status: "completed", error: null,
    created_at: "2026-09-29T10:00:00Z", started_at: "2026-09-29T10:00:00Z", finished_at: "2026-09-29T10:00:30Z",
    resumed_from: null, usage: { requests: 2, input_tokens: 1200, output_tokens: 300 }, ...over };
}

export function item<T extends Item["type"]>(turnId: string, type: T, payload: Extract<Item, { type: T }>["payload"],
  over: Partial<Item> = {}): Item {
  seq += 1;
  return { seq, id: `i${seq}`, task_id: "task-1", turn_id: turnId, type, payload,
    created_at: `2026-09-29T10:00:${String(seq).padStart(2, "0")}Z`, ...over } as Item;
}

export function snapshot(turns: Turn[], items: Item[], over: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    task: { id: "task-1", title: "Survey", title_source: "agent", origin: "user", state: "ready",
      created_at: "2026-09-29T10:00:00Z", updated_at: "2026-09-29T10:00:30Z", head_turn_id: turns[turns.length - 1]?.id ?? null },
    state: "ready", running_turn_id: null, queued: [], turns, items, forks: {}, live: null, files: [], artifacts: [],
    last_seq: items.length ? items[items.length - 1].seq : 0, ...over,
  };
}
