import { useCallback, useEffect, useReducer, useRef } from "react";
import { api, streamUrl } from "../api";
import type { Item, LiveSegment, StateEvent, TaskSnapshot, TaskState, Turn, TurnStatus } from "../api/types";

/**
 * One Task, as the window reads it. The snapshot seeds it; after that every
 * durable item, turn change and live delta arrives on one stream that resumes
 * by seq. A snapshot is MERGED, never swapped in: anything that arrived after
 * the server built it is kept, so a follow-up never loses a word.
 *
 * The model knows every turn it has heard of (`allTurns`) and reads the branch
 * from the head, so a new Direction appears the moment its `turn` event lands.
 */

export type TaskModel = {
  id: string;
  snapshot: TaskSnapshot | null;
  allTurns: Record<string, Turn>;
  head: string | null;
  /** The branch being read, oldest first. */
  turns: Turn[];
  items: Item[];
  live: LiveSegment | null;
  state: TaskState;
  runningTurnId: string | null;
  queuedTurnIds: string[];
  lastSeq: number;
  connected: boolean;
  error: string | null;
};

export type Action =
  | { type: "reset"; id: string }
  | { type: "snapshot"; snapshot: TaskSnapshot }
  | { type: "item"; item: Item }
  | { type: "turn"; turn: Turn }
  | { type: "delta"; turn_id: string; segment_id: string; text: string }
  | { type: "live"; live: LiveSegment | null }
  | { type: "state"; state: StateEvent }
  | { type: "connected"; connected: boolean }
  | { type: "error"; error: string | null };

export function initial(id: string): TaskModel {
  return { id, snapshot: null, allTurns: {}, head: null, turns: [], items: [], live: null, state: "ready",
    runningTurnId: null, queuedTurnIds: [], lastSeq: 0, connected: false, error: null };
}

const NOTICE_STATUS: Partial<Record<string, TurnStatus>> = {
  started: "running", completed: "completed", failed: "failed", cancelled: "cancelled", interrupted: "interrupted",
};

/** The chain from the head to the root, oldest first. */
export function branchOf(all: Record<string, Turn>, head: string | null): Turn[] {
  const out: Turn[] = [];
  const seen = new Set<string>();
  for (let cur = head; cur && all[cur] && !seen.has(cur); cur = all[cur].parent_turn_id) {
    seen.add(cur);
    out.push(all[cur]);
  }
  return out.reverse();
}

function withBranch(m: TaskModel): TaskModel {
  return { ...m, turns: branchOf(m.allTurns, m.head) };
}

/** Insert by seq, once. Items almost always arrive in order: the fast path appends. */
function insert(items: Item[], it: Item): Item[] {
  const last = items[items.length - 1];
  if (!last || last.seq < it.seq) return [...items, it];
  if (items.some((x) => x.seq === it.seq)) return items;
  return [...items, it].sort((a, b) => a.seq - b.seq);
}

function persisted(items: Item[], segmentId: string): boolean {
  for (let i = items.length - 1; i >= 0; i--) if (items[i].id === segmentId) return true;
  return false;
}

function applyNotice(allTurns: Record<string, Turn>, it: Item): Record<string, Turn> {
  if (it.type !== "notice" || !it.turn_id) return allTurns;
  const status = NOTICE_STATUS[it.payload.event];
  const t = allTurns[it.turn_id];
  if (!status || !t) return allTurns;
  const times = status === "running" ? { started_at: t.started_at ?? it.created_at }
    : status === "queued" ? {} : { finished_at: it.created_at };
  return { ...allTurns, [t.id]: { ...t, status, ...times } };
}

export function reduce(m: TaskModel, a: Action): TaskModel {
  switch (a.type) {
    case "reset":
      return initial(a.id);
    case "snapshot": {
      const s = a.snapshot;
      if (m.id && s.task.id !== m.id) return m; // a late answer for the task the reader left
      const allTurns = { ...m.allTurns };
      for (const t of s.turns) allTurns[t.id] = t;
      // Keep what arrived after the server built this snapshot; replay notices onto its turns.
      const newer = m.items.filter((x) => x.seq > s.last_seq);
      let items = s.items;
      let turns = allTurns;
      for (const it of newer) {
        items = insert(items, it);
        turns = applyNotice(turns, it);
      }
      const liveSrc = m.live && (!s.live || s.live.segment_id !== m.live.segment_id || m.live.text.length >= s.live.text.length)
        ? m.live : s.live;
      const live = liveSrc && !persisted(items, liveSrc.segment_id) ? liveSrc : null;
      return withBranch({
        ...m, id: s.task.id, snapshot: s, allTurns: turns, head: s.head_turn_id ?? s.task.head_turn_id, items, live,
        state: s.state, runningTurnId: s.running_turn_id, queuedTurnIds: s.queued.map((q) => q.turn_id),
        lastSeq: Math.max(m.lastSeq, s.last_seq), error: null,
      });
    }
    case "turn": {
      const prev = m.allTurns[a.turn.id];
      // Status also moves with notices; never let an older event move it back.
      const turn = prev && prev.status !== "queued" && a.turn.status === "queued" ? { ...a.turn, status: prev.status } : a.turn;
      const allTurns = { ...m.allTurns, [turn.id]: turn };
      // A new turn continues the branch being read (or starts it).
      const head = !prev && (turn.parent_turn_id === m.head || !m.head) ? turn.id : m.head;
      return withBranch({ ...m, allTurns, head });
    }
    case "item": {
      const it = a.item;
      const items = insert(m.items, it);
      if (items === m.items) return m;
      let snapshot = m.snapshot;
      if (it.type === "notice" && it.payload.event === "titled" && it.payload.title && snapshot) {
        snapshot = { ...snapshot, task: { ...snapshot.task, title: it.payload.title } };
      }
      const allTurns = applyNotice(m.allTurns, it);
      const live = it.type === "agent_message" && m.live?.segment_id === it.id ? null : m.live;
      const next = { ...m, snapshot, items, allTurns, live, lastSeq: Math.max(m.lastSeq, it.seq) };
      return allTurns === m.allTurns ? next : withBranch(next);
    }
    case "delta": {
      if (m.live?.segment_id === a.segment_id) return { ...m, live: { ...m.live, text: m.live.text + a.text } };
      if (persisted(m.items, a.segment_id)) return m; // a late delta of a stored segment
      return { ...m, live: { turn_id: a.turn_id, segment_id: a.segment_id, text: a.text } };
    }
    case "live": {
      const l = a.live;
      if (!l || persisted(m.items, l.segment_id)) return m.live && l && m.live.segment_id === l.segment_id ? { ...m, live: null } : m;
      if (m.live?.segment_id === l.segment_id && m.live.text.length >= l.text.length) return m;
      return { ...m, live: l };
    }
    case "state": {
      const st = a.state;
      const head = st.head_turn_id !== undefined && st.head_turn_id !== null && m.allTurns[st.head_turn_id] ? st.head_turn_id : m.head;
      return withBranch({ ...m, state: st.state, runningTurnId: st.running_turn_id, queuedTurnIds: st.queued_turn_ids,
        head, live: st.running_turn_id ? m.live : null });
    }
    case "connected":
      return { ...m, connected: a.connected };
    case "error":
      return { ...m, error: a.error };
  }
}

/** A turn the model still marks running although the runtime runs something else (or nothing). */
export function stale(m: TaskModel): boolean {
  return m.turns.some((t) => t.status === "running" && t.id !== m.runningTurnId);
}

const RETRY_MS = [500, 1000, 2000, 4000, 8000];

/** Follow one task. `reload` re-reads the snapshot (after a branch switch); it merges, never loses. */
export function useTask(id: string | null) {
  const [model, dispatch] = useReducer(reduce, id ?? "", initial);
  const seqRef = useRef(0);
  const known = useRef<Record<string, Turn>>({});
  useEffect(() => {
    seqRef.current = model.lastSeq;
    known.current = model.allTurns;
  }, [model.lastSeq, model.allTurns]);

  const reload = useCallback(async (): Promise<TaskSnapshot | null> => {
    if (!id) return null;
    try {
      const s = await api.task(id);
      dispatch({ type: "snapshot", snapshot: s });
      return s;
    } catch (err) {
      dispatch({ type: "error", error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }, [id]);

  useEffect(() => {
    dispatch({ type: "reset", id: id ?? "" });
    seqRef.current = 0;
    known.current = {};
    if (!id) return;
    let closed = false;
    let source: EventSource | null = null;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pendingReload: ReturnType<typeof setTimeout> | undefined;
    const reloadSoon = () => {
      clearTimeout(pendingReload);
      pendingReload = setTimeout(() => void reload(), 80);
    };

    const open = (after: number) => {
      if (closed) return;
      source = new EventSource(streamUrl(`/tasks/${id}/events?after=${after}`));
      source.addEventListener("open", () => {
        attempt = 0;
        dispatch({ type: "connected", connected: true });
      });
      source.addEventListener("turn", (e) => {
        const turn = JSON.parse((e as MessageEvent).data) as Turn;
        known.current = { ...known.current, [turn.id]: turn };
        dispatch({ type: "turn", turn });
      });
      source.addEventListener("item", (e) => {
        const item = JSON.parse((e as MessageEvent).data) as Item;
        // An item of a turn this view never heard of (a reconnect missed its
        // `turn` event): read the snapshot again — it merges, it loses nothing.
        if (item.turn_id && !known.current[item.turn_id]) reloadSoon();
        dispatch({ type: "item", item });
      });
      source.addEventListener("delta", (e) => {
        const d = JSON.parse((e as MessageEvent).data) as { turn_id: string; segment_id: string; text: string };
        dispatch({ type: "delta", ...d });
      });
      source.addEventListener("live", (e) => dispatch({ type: "live", live: JSON.parse((e as MessageEvent).data) }));
      source.addEventListener("state", (e) => dispatch({ type: "state", state: JSON.parse((e as MessageEvent).data) }));
      source.addEventListener("error", () => {
        source?.close();
        dispatch({ type: "connected", connected: false });
        if (closed) return;
        timer = setTimeout(() => open(seqRef.current), RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)]);
      });
    };

    // Follow from exactly where the snapshot ends.
    void reload().then((s) => {
      if (s) {
        known.current = Object.fromEntries(s.turns.map((t) => [t.id, t]));
        open(s.last_seq);
      } else open(0);
    });
    return () => {
      closed = true;
      clearTimeout(timer);
      clearTimeout(pendingReload);
      source?.close();
    };
  }, [id, reload]);

  // Heal a turn left "running" after the runtime moved on (a notice lost to a dropped stream).
  const isStale = stale(model);
  useEffect(() => {
    if (!isStale || !model.connected) return;
    const t = setTimeout(() => void reload(), 400);
    return () => clearTimeout(t);
  }, [isStale, model.connected, reload]);

  return { model, reload, setSnapshot: (s: TaskSnapshot) => dispatch({ type: "snapshot", snapshot: s }) };
}
