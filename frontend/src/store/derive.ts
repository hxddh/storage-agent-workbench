import type { Finding, Item, ItemOf, LiveSegment, Turn } from "../api/types";
import type { AnalysisDocument, TaskProvenance } from "../viz/types";

/**
 * Pure projections of one branch's items into what the page reads. Nothing
 * here guesses: a turn's answer is the model's last message after its last
 * tool call; its conclusion is the `record_conclusion` item or nothing.
 */

export type ToolRow = {
  callId: string;
  name: string;
  target: string;
  args: Record<string, unknown>;
  status: "running" | "ok" | "failed" | "refused";
  summary: string | null;
  durationMs: number | null;
  detail: string | null;
  detailTruncated: boolean;
  progress: { done: number; total: number; unit: string } | null;
  startedAt: string;
};

export type Block =
  | { kind: "commentary"; id: string; text: string }
  | { kind: "work"; id: string; tools: ToolRow[]; startedAt: string; endedAt: string | null }
  | { kind: "steer"; id: string; text: string }
  | { kind: "compacted"; id: string };

export type Section = {
  turn: Turn;
  direction: string;
  attachments: ItemOf<"user_message">["payload"]["attachments"];
  blocks: Block[];
  answer: string | null;
  conclusion: ItemOf<"conclusion">["payload"] | null;
  error: ItemOf<"error">["payload"] | null;
  stopped: boolean;
  finalized: boolean;
  live: LiveSegment | null;
  toolCount: number;
};

const LIVE_STATUSES = new Set(["queued", "running"]);

export function isLive(turn: Turn): boolean {
  return LIVE_STATUSES.has(turn.status);
}

export function sections(turns: Turn[], items: Item[], live: LiveSegment | null): Section[] {
  const byTurn = new Map<string, Item[]>();
  for (const it of items) {
    if (!it.turn_id) continue;
    const list = byTurn.get(it.turn_id) ?? [];
    list.push(it);
    byTurn.set(it.turn_id, list);
  }
  return turns.map((turn) => section(turn, byTurn.get(turn.id) ?? [], live?.turn_id === turn.id ? live : null));
}

function section(turn: Turn, items: Item[], live: LiveSegment | null): Section {
  const blocks: Block[] = [];
  const rows = new Map<string, ToolRow>();
  let group: Extract<Block, { kind: "work" }> | null = null;
  let conclusion: Section["conclusion"] = null;
  let error: Section["error"] = null;
  let stopped = false;
  let finalized = false;
  let direction = turn.direction;
  let attachments: Section["attachments"];
  let lastToolIndex = -1;
  const messages: Array<{ index: number; item: ItemOf<"agent_message"> }> = [];

  for (const it of items) {
    switch (it.type) {
      case "user_message":
        direction = it.payload.text;
        attachments = it.payload.attachments;
        break;
      case "agent_message":
        messages.push({ index: blocks.length, item: it });
        blocks.push({ kind: "commentary", id: it.id, text: it.payload.text });
        group = null;
        break;
      case "tool_call": {
        const row: ToolRow = { callId: it.payload.call_id, name: it.payload.name, target: it.payload.target,
          args: it.payload.args, status: "running", summary: null, durationMs: null, detail: null,
          detailTruncated: false, progress: null, startedAt: it.created_at };
        rows.set(row.callId, row);
        if (!group) {
          group = { kind: "work", id: `work-${it.id}`, tools: [], startedAt: it.created_at, endedAt: null };
          blocks.push(group);
        }
        group.tools.push(row);
        lastToolIndex = blocks.length - 1;
        break;
      }
      case "tool_progress": {
        const row = rows.get(it.payload.call_id);
        if (row) row.progress = { done: it.payload.done, total: it.payload.total, unit: it.payload.unit };
        break;
      }
      case "tool_output": {
        const row = rows.get(it.payload.call_id);
        if (row) {
          row.status = it.payload.refused ? "refused" : it.payload.ok ? "ok" : "failed";
          row.summary = it.payload.summary || null;
          row.durationMs = it.payload.duration_ms ?? null;
          row.detail = it.payload.detail ?? null;
          row.detailTruncated = Boolean(it.payload.detail_truncated);
        }
        if (group) group.endedAt = it.created_at;
        break;
      }
      case "conclusion":
        conclusion = it.payload;
        break;
      case "steer":
        blocks.push({ kind: "steer", id: it.id, text: it.payload.text });
        group = null;
        break;
      case "compaction":
        blocks.unshift({ kind: "compacted", id: it.id });
        break;
      case "notice":
        if (it.payload.event === "cancelled" || it.payload.event === "stopped") stopped = true;
        if (it.payload.event === "finalized") finalized = true;
        if (it.payload.event === "compacted" && !blocks.some((b) => b.kind === "compacted")) {
          blocks.unshift({ kind: "compacted", id: it.id });
        }
        break;
      case "error":
        error = it.payload;
        break;
    }
  }

  // The answer is the last message after the last tool call; it leaves the commentary.
  let answer: string | null = null;
  const last = messages[messages.length - 1];
  if (last && last.index > lastToolIndex && !isLive(turn)) {
    answer = last.item.payload.text;
    const at = blocks.findIndex((b) => b.kind === "commentary" && b.id === last.item.id);
    if (at >= 0) blocks.splice(at, 1);
  }
  if (!isLive(turn)) {
    for (const b of blocks) if (b.kind === "work") for (const r of b.tools) if (r.status === "running") r.status = "failed";
  }
  const toolCount = blocks.reduce((n, b) => n + (b.kind === "work" ? b.tools.length : 0), 0);
  return { turn, direction, attachments, blocks, answer, conclusion, error, stopped, finalized, live, toolCount };
}

/** The latest turn that produced something to read. */
export function latestResult(all: Section[]): Section | null {
  for (let i = all.length - 1; i >= 0; i--) {
    const s = all[i];
    if (isLive(s.turn)) continue;
    if (s.answer || s.conclusion) return s;
  }
  return null;
}

const SEVERITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2, info: 3 };

export type UnifiedFinding = Finding & { turnId: string };

/** Every recorded finding on the branch, latest first, de-duplicated on its words, most severe first. */
export function findings(all: Section[]): UnifiedFinding[] {
  const seen = new Set<string>();
  const out: UnifiedFinding[] = [];
  for (let i = all.length - 1; i >= 0; i--) {
    for (const f of all[i].conclusion?.findings ?? []) {
      const key = f.title.toLowerCase().replace(/\s+/g, " ").trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ ...f, turnId: all[i].turn.id });
    }
  }
  return out.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3));
}

export function allTools(all: Section[]): ToolRow[] {
  return all.flatMap((s) => s.blocks.flatMap((b) => (b.kind === "work" ? b.tools : [])));
}

function parse(detail: string | null): Record<string, unknown> | null {
  if (!detail) return null;
  try {
    const v = JSON.parse(detail);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null; // a truncated detail is not a figure
  }
}

/** Figures come from the deterministic analyses a turn ran — never from prose. */
export function figures(section: Section | null): TaskProvenance | null {
  if (!section) return null;
  const analysis: TaskProvenance["analysis"] = { cost: null, inventory: null, access_log: null, drift: null };
  for (const b of section.blocks) {
    if (b.kind !== "work") continue;
    for (const r of b.tools) {
      if (r.status !== "ok") continue;
      const doc = parse(r.detail);
      if (!doc) continue;
      const base = { tool: r.name, call_id: r.callId, created_at: r.startedAt };
      if (r.name === "simulate_storage_cost" && doc.kind === "simulation") {
        analysis.cost = { ...base, document: doc, coverage: (doc.coverage as AnalysisDocument["coverage"]) ?? null };
      } else if ((r.name === "analyze_uploaded_file" || r.name === "import_evidence")) {
        const a = (r.name === "import_evidence" ? parse(JSON.stringify(doc.analysis ?? null)) : doc) ?? null;
        const metrics = a?.metrics as Record<string, unknown> | undefined;
        if (!a || !metrics) continue;
        const coverage: AnalysisDocument["coverage"] = {
          truncated: Boolean((a.notes as unknown[] | undefined)?.length),
          ...(a.dataset_type === "access_log"
            ? { total_requests: (metrics.total_requests as number | undefined) ?? (a.rows as number | null) ?? null }
            : { object_count: (metrics.object_count as number | undefined) ?? null,
                bytes: (metrics.total_size as number | undefined) ?? null }),
        };
        if (a.dataset_type === "access_log") analysis.access_log = { ...base, document: metrics, coverage };
        else if (a.dataset_type === "inventory") analysis.inventory = { ...base, document: metrics, coverage };
      }
    }
  }
  if (!analysis.cost && !analysis.inventory && !analysis.access_log) return null;
  return { task_id: "", findings: [], figures: [], analysis };
}

/** Versions of a Direction: its siblings (same parent), in creation order. */
export function versions(forks: Record<string, string[]>, turn: Turn): { index: number; ids: string[] } | null {
  const ids = forks[turn.parent_turn_id ?? ""];
  if (!ids || ids.length < 2) return null;
  const index = ids.indexOf(turn.id);
  return index < 0 ? null : { index, ids };
}
