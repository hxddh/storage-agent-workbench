import { useCallback, useEffect, useReducer, useRef } from "react";
import { api, streamUrl } from "../api";
import type { Item, LiveSegment, StateEvent, TaskSnapshot, TaskState, Turn, TurnStatus } from "../api/types";

/**
 * One Task, as the window reads it: the snapshot of the branch being read,
 * then every durable item and live delta as it happens. One reducer; the
 * stream resumes by seq, so a reconnect never loses or doubles an item.
 */

export type TaskModel = {
  id: string;
  snapshot: TaskSnapshot | null;
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
  | { type: "delta"; turn_id: string; segment_id: string; text: string }
  | { type: "live"; live: LiveSegment | null }
  | { type: "state"; state: StateEvent }
  | { type: "connected"; connected: boolean }
  | { type: "error"; error: string | null };

export function initial(id: string): TaskModel {
  return { id, snapshot: null, turns: [], items: [], live: null, state: "ready", runningTurnId: null,
    queuedTurnIds: [], lastSeq: 0, connected: false, error: null };
}

const NOTICE_STATUS: Partial<Record<string, TurnStatus>> = {
  started: "running", completed: "completed", failed: "failed", cancelled: "cancelled", interrupted: "interrupted",
};

export function reduce(m: TaskModel, a: Action): TaskModel {
  switch (a.type) {
    case "reset":
      return initial(a.id);
    case "snapshot": {
      const s = a.snapshot;
      if (m.id && s.task.id !== m.id) return m; // a late answer for the task the reader left
      return { ...m, id: s.task.id, snapshot: s, turns: s.turns, items: s.items, live: s.live, state: s.state,
        runningTurnId: s.running_turn_id, queuedTurnIds: s.queued.map((q) => q.turn_id),
        lastSeq: Math.max(m.lastSeq, s.last_seq), error: null };
    }
    case "item": {
      const it = a.item;
      if (it.seq <= m.lastSeq && m.items.some((x) => x.seq === it.seq)) return m;
      const lastSeq = Math.max(m.lastSeq, it.seq);
      if (!m.turns.some((t) => t.id === it.turn_id)) return { ...m, lastSeq }; // another branch
      let turns = m.turns;
      let snapshot = m.snapshot;
      if (it.type === "notice" && it.payload.event === "titled" && it.payload.title && snapshot) {
        snapshot = { ...snapshot, task: { ...snapshot.task, title: it.payload.title } };
      }
      if (it.type === "notice" && NOTICE_STATUS[it.payload.event]) {
        const status = NOTICE_STATUS[it.payload.event]!;
        turns = m.turns.map((t) => (t.id === it.turn_id ? { ...t, status } : t));
      }
      const live = it.type === "agent_message" && m.live?.segment_id === it.id ? null : m.live;
      const items = m.items.length && m.items[m.items.length - 1].seq > it.seq
        ? [...m.items, it].sort((x, y) => x.seq - y.seq)
        : [...m.items, it];
      return { ...m, snapshot, items, turns, live, lastSeq };
    }
    case "delta": {
      if (!m.turns.some((t) => t.id === a.turn_id)) return m;
      const text = m.live?.segment_id === a.segment_id ? m.live.text + a.text : a.text;
      return { ...m, live: { turn_id: a.turn_id, segment_id: a.segment_id, text } };
    }
    case "live":
      return { ...m, live: a.live && m.turns.some((t) => t.id === a.live!.turn_id) ? a.live : null };
    case "state":
      return { ...m, state: a.state.state, runningTurnId: a.state.running_turn_id, queuedTurnIds: a.state.queued_turn_ids,
        live: a.state.running_turn_id ? m.live : null };
    case "connected":
      return { ...m, connected: a.connected };
    case "error":
      return { ...m, error: a.error };
  }
}

const RETRY_MS = [500, 1000, 2000, 4000, 8000];

/** Follow one task. `reload` re-reads the snapshot (after a fork, a branch switch, a new turn). */
export function useTask(id: string | null) {
  const [model, dispatch] = useReducer(reduce, id ?? "", initial);
  const seqRef = useRef(0);
  const turnsRef = useRef<Set<string>>(new Set());
  seqRef.current = model.lastSeq;
  turnsRef.current = new Set(model.turns.map((t) => t.id));

  const reload = useCallback(async () => {
    if (!id) return;
    try {
      dispatch({ type: "snapshot", snapshot: await api.task(id) });
    } catch (err) {
      dispatch({ type: "error", error: err instanceof Error ? err.message : String(err) });
    }
  }, [id]);

  useEffect(() => {
    dispatch({ type: "reset", id: id ?? "" });
    seqRef.current = 0;
    if (!id) return;
    let closed = false;
    let source: EventSource | null = null;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pendingReload: ReturnType<typeof setTimeout> | undefined;
    const reloadSoon = () => {
      clearTimeout(pendingReload);
      pendingReload = setTimeout(() => void reload(), 60);
    };

    const open = () => {
      if (closed) return;
      source = new EventSource(streamUrl(`/tasks/${id}/events?after=${seqRef.current}`));
      source.addEventListener("open", () => {
        attempt = 0;
        dispatch({ type: "connected", connected: true });
      });
      source.addEventListener("item", (e) => {
        const item = JSON.parse((e as MessageEvent).data) as Item;
        // A turn this view has not seen yet (a new Direction, a fork): read the branch again.
        if (item.turn_id && !turnsRef.current.has(item.turn_id) && item.type === "user_message") reloadSoon();
        else if (item.type === "notice" && item.payload.event === "resumed") reloadSoon();
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
        timer = setTimeout(open, RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)]);
      });
    };

    void reload().then(open);
    return () => {
      closed = true;
      clearTimeout(timer);
      clearTimeout(pendingReload);
      source?.close();
    };
  }, [id, reload]);

  return { model, reload, setSnapshot: (s: TaskSnapshot) => dispatch({ type: "snapshot", snapshot: s }) };
}
