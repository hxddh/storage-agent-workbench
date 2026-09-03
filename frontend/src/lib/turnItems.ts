/**
 * The turn model (v1.11, Codex parity).
 *
 * A turn is: user message → [commentary segment | tool rows | approval]* →
 * answer. Live, the items are built from the durable event stream; after the
 * execution settles the persisted message's `turn_items` + `tool_activity` +
 * `content` reproduce the same list. Both feed ONE renderer.
 */
import type { ApprovalGrantPolicy, DecisionImpact, TaskDecision } from "../api";
import type { PlanStep, SessionMessage, ToolActivity, TurnItemRef } from "../types";

export type ApprovalStatus = "pending" | "approved" | "declined" | "superseded" | "granted";

export type ApprovalItem = {
  kind: "approval";
  decision_id: string;
  action_type: string;
  title: string | null;
  reason: string | null;
  impact: DecisionImpact | null;
  status: ApprovalStatus;
  scope?: "once" | "task" | null;
  /** Why a `granted` approval never asked (v1.12 approval policy). */
  policy?: ApprovalGrantPolicy | null;
};

/** The plan the model owns (v1.12): ONE item per turn, updated in place. */
export type PlanItem = { kind: "plan"; steps: PlanStep[] };

/** The runtime compacted the replayed context at this point (v1.12). */
export type CompactedItem = { kind: "compacted"; before_tokens: number | null; after_tokens: number | null };

export type TurnItem =
  | { kind: "message"; text: string; live?: boolean }
  | { kind: "tool"; record: ToolActivity }
  | ApprovalItem
  | PlanItem
  | CompactedItem;

export type LiveTurn = {
  items: TurnItem[];
  answer: string | null;
  waiting: boolean;
};

export const EMPTY_TURN: LiveTurn = { items: [], answer: null, waiting: false };

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
  // The open segment is the last LIVE message; tool rows or an approval may
  // sit after it when their events landed before the segment closed.
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

export function openApproval(
  turn: LiveTurn,
  payload: { decision_id: string; action_type: string; title: string | null; reason: string | null; impact: DecisionImpact | null },
): LiveTurn {
  if (turn.items.some((item) => item.kind === "approval" && item.decision_id === payload.decision_id)) return turn;
  return {
    ...turn,
    waiting: true,
    items: [...turn.items, { kind: "approval", ...payload, status: "pending" }],
  };
}

export function grantApproval(
  turn: LiveTurn,
  payload: { decision_id: string; action_type: string; title: string | null; policy?: ApprovalGrantPolicy | null },
): LiveTurn {
  if (turn.items.some((item) => item.kind === "approval" && item.decision_id === payload.decision_id)) return turn;
  const { policy = null, ...rest } = payload;
  return {
    ...turn,
    items: [...turn.items, {
      kind: "approval", ...rest, reason: null, impact: null, status: "granted",
      scope: policy === "task" || policy == null ? "task" : null, policy,
    }],
  };
}

/** `plan.updated` (v1.12): the FIRST call in a turn places ONE plan item at
 * the current position; every later call rewrites that item in place. */
export function applyPlan(turn: LiveTurn, steps: PlanStep[]): LiveTurn {
  const bounded = steps.slice(0, 12).map((step) => ({
    text: String(step.text ?? ""),
    status: step.status === "completed" || step.status === "in_progress" ? step.status : "pending" as const,
  }));
  const i = turn.items.findIndex((item) => item.kind === "plan");
  const items = turn.items.slice();
  if (i >= 0) items[i] = { kind: "plan", steps: bounded };
  else items.push({ kind: "plan", steps: bounded });
  return { ...turn, items };
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

export function resolveApproval(
  turn: LiveTurn,
  payload: { decision_id: string; resolution: string; scope?: "once" | "task" | null },
): LiveTurn {
  const status: ApprovalStatus = payload.resolution === "approved" ? "approved"
    : payload.resolution === "superseded" ? "superseded" : "declined";
  let changed = false;
  const items = turn.items.map((item) => {
    if (item.kind !== "approval" || item.decision_id !== payload.decision_id) return item;
    changed = true;
    return { ...item, status, scope: payload.scope ?? item.scope ?? null };
  });
  const waiting = items.some((item) => item.kind === "approval" && item.status === "pending");
  return changed || waiting !== turn.waiting ? { ...turn, items, waiting } : turn;
}

export function applyStatus(turn: LiveTurn, status: string): LiveTurn {
  if (status === "waiting") return turn.waiting ? turn : { ...turn, waiting: true };
  if (status === "running" && turn.waiting) return { ...turn, waiting: false };
  return turn;
}

function approvalFromDecision(decision: TaskDecision): ApprovalItem {
  return {
    kind: "approval",
    decision_id: decision.id,
    action_type: decision.action_type,
    title: decision.title,
    reason: decision.reason,
    impact: decision.impact ?? null,
    status: decision.status,
    scope: decision.scope ?? null,
  };
}

/**
 * The durable projection: the persisted message's ordered `turn_items` with
 * tool references resolved against `tool_activity`. A pre-1.11 row (no items)
 * renders its tool rows as one group before the answer. A pending inline
 * approval renders at the tool row that raised it.
 */
export function turnItemsOf(
  message: Pick<SessionMessage, "turn_items" | "tool_activity">,
  pendingDecisions: TaskDecision[] = [],
): TurnItem[] {
  const activity = message.tool_activity ?? [];
  const refs: TurnItemRef[] = message.turn_items ?? [];
  const byId = new Map<string, ToolActivity>();
  for (const record of activity) if (record.id) byId.set(record.id, record);
  const pendingById = new Map(pendingDecisions.filter((d) => d.status === "pending").map((d) => [d.id, d]));
  const items: TurnItem[] = [];
  const seen = new Set<string>();
  const pushTool = (record: ToolActivity) => {
    items.push({ kind: "tool", record });
    if (record.id) seen.add(record.id);
    const decision = record.decision_id ? pendingById.get(record.decision_id) : undefined;
    if (decision) items.push(approvalFromDecision(decision));
  };
  for (const ref of refs) {
    if (ref.kind === "message") {
      if (ref.text.trim()) items.push({ kind: "message", text: ref.text });
    } else if (ref.kind === "tool") {
      const record = byId.get(ref.id);
      if (record && !seen.has(ref.id)) pushTool(record);
    } else if (ref.kind === "plan") {
      if (Array.isArray(ref.steps) && ref.steps.length && !items.some((item) => item.kind === "plan")) {
        items.push({ kind: "plan", steps: ref.steps });
      }
    } else if (ref.kind === "compacted") {
      items.push({ kind: "compacted", before_tokens: ref.before_tokens ?? null, after_tokens: ref.after_tokens ?? null });
    }
  }
  // Tool rows the item list did not reference (pre-1.11 rows, or a call the
  // runtime recorded after its last segment) still belong to the turn.
  for (const record of activity) {
    if (record.id && seen.has(record.id)) continue;
    if (!record.id && refs.length > 0) continue;
    pushTool(record);
  }
  return items;
}

/** Pending approvals the document did not place at a tool row. */
export function unplacedApprovals(placed: TurnItem[][], pendingDecisions: TaskDecision[]): ApprovalItem[] {
  const shown = new Set<string>();
  for (const items of placed) for (const item of items) if (item.kind === "approval") shown.add(item.decision_id);
  return pendingDecisions
    .filter((d) => d.status === "pending" && !shown.has(d.id))
    .map(approvalFromDecision);
}

/** Split a turn's items into renderable segments: consecutive tool rows fold
 * into ONE worked group; commentary and approvals stay in order. */
export type TurnSegment =
  | { kind: "commentary"; text: string; live: boolean }
  | { kind: "worked"; records: ToolActivity[] }
  | ApprovalItem
  | PlanItem
  | CompactedItem;

export function segmentsOf(items: TurnItem[]): TurnSegment[] {
  const out: TurnSegment[] = [];
  for (const item of items) {
    if (item.kind === "tool") {
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
