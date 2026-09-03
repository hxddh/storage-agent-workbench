import { sidecarBaseUrl } from "../config";
import { authHeaders, errorDetail, request } from "./client";
import type { ExecutionMetrics, PlanStep, ToolActivity } from "../types";

/**
 * The durable Agent Task runtime (v0.94, one protocol since v1.12).
 *
 * The Agent Task and its Executions are durable domain objects: submitting a
 * Direction creates an execution row, progress is an append-only structured
 * event log addressable by sequence number, and Decision / Work Result /
 * Artifact are first-class rows. The client only OBSERVES executions —
 * closing a stream, switching tasks, or reloading never interrupts one.
 *
 * The ONLY submission lifecycle is: `POST /agent-tasks/{id}/executions` →
 * follow `GET …/executions/{eid}/events` (SSE, resume with `after=<seq>`) →
 * steer / stop / resume → reload the persisted task. There is no session
 * message endpoint, no turn cancel path, and no blocking fallback.
 */

export type { PlanStep };

export interface TaskExecution {
  id: string;
  task_id: string;
  turn_id: string | null;
  direction: string | null;
  kind: string;
  status: "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted";
  error: string | null;
  resumed_from: string | null;
  steer_count: number;
  work_result_id: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface DecisionImpact {
  gate: "cloud_download" | "artifact_write" | "confirmation" | string;
  why: string | null;
  bucket: string | null;
  prefix: string | null;
  source_type: string | null;
  file_count: number | null;
  total_bytes: number | null;
  scan_scope: string | null;
  warnings?: string[];
}

export interface TaskDecision {
  id: string;
  task_id: string;
  execution_id: string | null;
  work_result_id: string | null;
  action_type: string;
  title: string | null;
  reason: string | null;
  /** `approval` (raised inline by a gated tool, v1.11) or a legacy `proposal`. */
  kind?: "approval" | "proposal";
  /** How the approval was granted: once, or for every later call in this task. */
  scope?: "once" | "task" | null;
  proposal?: Record<string, unknown> | null;
  status: "pending" | "approved" | "declined" | "superseded";
  resolution_note: string | null;
  created_at: string;
  resolved_at: string | null;
  impact?: DecisionImpact | null;
}

export interface TaskState {
  task_id: string;
  status: "ready" | "working" | "needs_decision" | "needs_attention" | "archived";
  active_execution: TaskExecution | null;
  last_event_seq: number;
  last_execution: TaskExecution | null;
  queued_executions: TaskExecution[];
  pending_decisions: TaskDecision[];
  context_version: number;
}

/** One row of the durable execution log (`GET /agent-tasks/{id}/events`). */
export interface TaskEvent {
  seq: number;
  execution_id: string;
  task_id?: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export const getTaskState = (taskId: string) =>
  request<TaskState>(`/agent-tasks/${taskId}/state`);

export const createTaskExecution = (
  taskId: string, direction: string, turnId?: string, kind?: "direction" | "verify" | "revisit",
) =>
  request<{ execution: TaskExecution; created: boolean }>(
    `/agent-tasks/${taskId}/executions`,
    { method: "POST", body: JSON.stringify({ direction, turn_id: turnId, ...(kind ? { kind } : {}) }) },
  );

/** Submit a Verify Execution through the one runtime submit path. */
export const verifyTaskPlan = (taskId: string) =>
  request<{ execution: TaskExecution; created: boolean }>(
    `/agent-tasks/${taskId}/verify`, { method: "POST" });

/** Steer the CURRENT execution — the direction is injected into the running
 * model loop server-side. 409 (ApiError) when nothing is executing. */
export const steerTaskExecution = (taskId: string, text: string) =>
  request<{ status: string; execution: TaskExecution }>(
    `/agent-tasks/${taskId}/steer`,
    { method: "POST", body: JSON.stringify({ text }) },
  );

/** The one cancel path: stop a queued, running or waiting execution by its
 * durable identity. A partial Work Result is persisted server-side. */
export const stopTaskExecution = (taskId: string, executionId: string) =>
  request<{ status: string; execution: TaskExecution }>(
    `/agent-tasks/${taskId}/executions/${executionId}/stop`, { method: "POST" });

export const resumeTaskExecution = (taskId: string, executionId: string) =>
  request<{ execution: TaskExecution; resumed_from: string }>(
    `/agent-tasks/${taskId}/executions/${executionId}/resume`, { method: "POST" });

export const listTaskExecutions = (taskId: string, limit = 50) =>
  request<{ task_id: string; executions: TaskExecution[] }>(
    `/agent-tasks/${taskId}/executions?limit=${limit}`);

/** One execution's header row (status, kind, direction, bounds, error). */
export const getTaskExecution = (taskId: string, executionId: string) =>
  request<TaskExecution>(`/agent-tasks/${taskId}/executions/${executionId}`);

/** One page of the task's durable event log, oldest-first from `after`. */
export const listTaskEvents = (taskId: string, opts: { after?: number; limit?: number } = {}) =>
  request<{ task_id: string; events: TaskEvent[]; last_seq: number }>(
    `/agent-tasks/${taskId}/events?after=${opts.after ?? 0}&limit=${opts.limit ?? 1000}`);

export const listTaskDecisions = (taskId: string, status?: string) =>
  request<{ task_id: string; decisions: TaskDecision[] }>(
    `/agent-tasks/${taskId}/decisions${status ? `?status_filter=${status}` : ""}`);

/** Resolve an inline approval. Approving wakes the gated tool server-side and
 * the SAME execution continues; `scope=task` also allows later calls of the
 * same action type in this task. */
export const resolveTaskDecision = (
  taskId: string, decisionId: string, resolution: "approved" | "declined",
  scope?: "once" | "task", note?: string,
) =>
  request<{ decision: TaskDecision; prepared: null }>(
    `/agent-tasks/${taskId}/decisions/${decisionId}/resolve`,
    { method: "POST", body: JSON.stringify({ resolution, note, ...(scope ? { scope } : {}) }) },
  );

// --- v1.12: on-demand compaction ---

export type CompactResult =
  | { compacted: true; before_tokens: number | null; after_tokens: number | null; summary_chars: number }
  | { compacted: false; reason: string };

/** Run the compaction step now, for a task with no live execution
 * (409 while one is active, 422 without a model). */
export const compactTaskContext = (taskId: string) =>
  request<CompactResult>(`/agent-tasks/${taskId}/compact`, { method: "POST" });

// --- The durable event stream -------------------------------------------------

// Abort a stream that has gone silent this long (no deltas/tools/heartbeat), so
// the client reconnects the durable event log at `after=<last seq>` rather than
// spinning indefinitely.
const STREAM_IDLE_TIMEOUT_MS = 120_000;
const STREAM_RECONNECT_MAX = 20;

export interface ExecutionStreamResult {
  status: string;
  message_id?: string;
  work_result_id?: string;
  stopped: boolean;
  metrics?: ExecutionMetrics;
  last_seq: number;
}

/** A closed assistant text segment (v1.11): commentary before an action
 * (`final=false`) or the answer (`final=true`). */
export interface MessageCompletedPayload {
  text: string;
  final: boolean;
  truncated?: boolean;
}

/** A gated tool paused the execution for the user's approval (v1.11). */
export interface ApprovalOpenedPayload {
  decision_id: string;
  action_type: string;
  title: string | null;
  reason: string | null;
  impact: DecisionImpact | null;
}

export interface DecisionResolvedPayload {
  decision_id: string;
  resolution: "approved" | "declined" | "superseded";
  action_type?: string;
  scope?: "once" | "task" | null;
}

export interface ExecutionStatusPayload {
  status: string;
  reason?: string;
  decision_id?: string;
  error?: string;
}

/** Why an approval was granted without asking (`approval.granted.policy`). */
export type ApprovalGrantPolicy = "task" | "session" | "always";

export interface ApprovalGrantedPayload {
  decision_id: string;
  action_type: string;
  title: string | null;
  policy?: ApprovalGrantPolicy | null;
}

/** `plan.updated`: the model replaced its plan (`update_plan`, ≤ 12 steps). */
export interface PlanUpdatedPayload {
  steps: PlanStep[];
}

/** `context.compacted`: the runtime summarised the replayed context. */
export interface ContextCompactedPayload {
  before_tokens: number | null;
  after_tokens: number | null;
  summary_chars: number;
}

/** `task.status`: the task's derived status, queue and pending Decisions —
 * everything a follower used to poll `/agent-tasks/{id}/state` for. */
export interface TaskStatusPayload {
  status: TaskState["status"];
  active_execution_id: string | null;
  queued: { id: string; direction: string | null; kind: string; created_at: string }[];
  pending_decisions: TaskDecision[];
  last_execution: { id: string; status: TaskExecution["status"] } | null;
}

/** What a live follower can listen for on the durable event stream. */
export interface LiveEventHandlers {
  onDelta: (text: string) => void;
  onTool: (a: ToolActivity) => void;
  onSeq?: (seq: number) => void;
  onMessageCompleted?: (payload: MessageCompletedPayload) => void;
  onApprovalOpened?: (payload: ApprovalOpenedPayload) => void;
  onApprovalGranted?: (payload: ApprovalGrantedPayload) => void;
  onDecisionResolved?: (payload: DecisionResolvedPayload) => void;
  onStatus?: (payload: ExecutionStatusPayload) => void;
  onTaskStatus?: (payload: TaskStatusPayload) => void;
  onPlanUpdated?: (payload: PlanUpdatedPayload) => void;
  onContextCompacted?: (payload: ContextCompactedPayload) => void;
}

/** The durable event stream dropped before a terminal status. Reconnect with
 * `after=lastSeq` — never a blocking POST and never a message-id poll. */
export class StreamDisconnectedError extends Error {
  lastSeq: number;
  constructor(lastSeq: number, message = "stream disconnected") {
    super(message);
    this.name = "StreamDisconnectedError";
    this.lastSeq = lastSeq;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A tool row from a `tool.started` / `tool.completed` payload. Wall-clock
 * bounds are the Sidecar's stamps when it sends them, else the moment this
 * client saw the frame (v1.12 "Worked for" span). */
export function toolFromEvent(payload: Record<string, unknown> | null | undefined, status: "started" | "completed", seenAt = new Date().toISOString()): ToolActivity {
  const p = (payload ?? {}) as Record<string, any>;
  return {
    id: p.id,
    tool: p.tool ?? "",
    target: p.target ?? "",
    result: p.result ?? "",
    ok: p.ok,
    status,
    ...(p.decision_id ? { decision_id: p.decision_id as string } : {}),
    ...(typeof p.duration_ms === "number" ? { duration_ms: p.duration_ms as number } : {}),
    ...(status === "started"
      ? { started_at: p.started_at ?? seenAt }
      : { started_at: p.started_at ?? null, finished_at: p.finished_at ?? seenAt }),
  };
}

/**
 * Dispatch one durable event (by type + payload) to a handler map. Shared by
 * the live SSE follower and the Execution detail document, which replays the
 * same log from `GET /agent-tasks/{id}/events` — one vocabulary, one reducer.
 * Returns the terminal result when the event settled the execution.
 */
export function dispatchDurableEvent(
  type: string,
  payload: Record<string, any>,
  on: LiveEventHandlers,
  seenAt?: string,
): { terminal: true; status: string; payload: Record<string, any> } | null {
  if (type === "tool.started") on.onTool(toolFromEvent(payload, "started", seenAt));
  else if (type === "tool.completed") on.onTool(toolFromEvent(payload, "completed", seenAt));
  else if (type === "steer.applied")
    on.onTool({ tool: "user_steer", target: "", result: payload.text || "", ok: true, status: "completed" });
  else if (type === "message.completed")
    on.onMessageCompleted?.({ text: payload.text ?? "", final: payload.final === true, truncated: payload.truncated === true });
  else if (type === "approval.opened")
    on.onApprovalOpened?.({
      decision_id: payload.decision_id, action_type: payload.action_type ?? "",
      title: payload.title ?? null, reason: payload.reason ?? null, impact: payload.impact ?? null,
    });
  else if (type === "approval.granted")
    on.onApprovalGranted?.({
      decision_id: payload.decision_id, action_type: payload.action_type ?? "", title: payload.title ?? null,
      policy: payload.policy ?? null,
    });
  else if (type === "task.status")
    on.onTaskStatus?.({
      status: payload.status, active_execution_id: payload.active_execution_id ?? null,
      queued: Array.isArray(payload.queued) ? payload.queued : [],
      pending_decisions: Array.isArray(payload.pending_decisions) ? payload.pending_decisions : [],
      last_execution: payload.last_execution ?? null,
    });
  else if (type === "plan.updated")
    on.onPlanUpdated?.({ steps: Array.isArray(payload.steps) ? payload.steps : [] });
  else if (type === "context.compacted")
    on.onContextCompacted?.({
      before_tokens: payload.before_tokens ?? null, after_tokens: payload.after_tokens ?? null,
      summary_chars: Number(payload.summary_chars) || 0,
    });
  else if (type === "decision.resolved")
    on.onDecisionResolved?.({
      decision_id: payload.decision_id, resolution: payload.resolution,
      action_type: payload.action_type, scope: payload.scope ?? null,
    });
  else if (type === "execution.status") {
    const st = payload.status as string;
    on.onStatus?.({ status: st, reason: payload.reason, decision_id: payload.decision_id, error: payload.error });
    if (st === "completed" || st === "failed" || st === "cancelled" || st === "interrupted") {
      return { terminal: true, status: st, payload };
    }
  }
  return null;
}

/** Follow one execution's durable structured event log as SSE.
 *
 * Every durable frame carries `id: <seq>`, so a broken connection resumes with
 * `after=<last seq>` and replays exactly what was missed — the stream is a
 * VIEW over durable rows, never the owner of the execution. Live answer text
 * arrives as transient `delta` frames. Resolves when the execution settles
 * (completed / waiting / cancelled); throws on `failed` / `interrupted`;
 * throws `StreamDisconnectedError` (with `lastSeq`) on idle timeout or a
 * dropped connection so the caller can reconnect. */
export async function streamExecutionEvents(
  taskId: string,
  executionId: string,
  on: LiveEventHandlers,
  opts: { signal?: AbortSignal; after?: number } = {},
): Promise<ExecutionStreamResult> {
  const localCtl = new AbortController();
  const { signal } = opts;
  if (signal) {
    if (signal.aborted) localCtl.abort();
    else signal.addEventListener("abort", () => localCtl.abort(), { once: true });
  }
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const kickIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => localCtl.abort(), STREAM_IDLE_TIMEOUT_MS);
  };
  kickIdle();
  const after = opts.after ?? 0;
  let lastSeq = after;
  const bumpSeq = (seq: number) => {
    lastSeq = seq;
    on.onSeq?.(seq);
  };
  try {
    const res = await fetch(
      `${sidecarBaseUrl()}/agent-tasks/${taskId}/executions/${executionId}/events?after=${after}`,
      { headers: { ...authHeaders() }, signal: localCtl.signal },
    );
    if (!res.ok || !res.body) {
      const err = new Error(await errorDetail(res)) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let result: ExecutionStreamResult | null = null;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        kickIdle();
        buf += dec.decode(value, { stream: true });
        const chunks = buf.split("\n\n");
        buf = chunks.pop() ?? "";
        for (const chunk of chunks) {
          const lines = chunk.split("\n");
          const type = lines.find((l) => l.startsWith("event:"))?.slice(6).trim();
          const idLine = lines.find((l) => l.startsWith("id:"))?.slice(3).trim();
          if (idLine) bumpSeq(Number(idLine) || lastSeq);
          const dataLines = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
          if (!type || dataLines.length === 0) continue;
          let data: any;
          try {
            data = JSON.parse(dataLines.join("\n"));
          } catch {
            continue;
          }
          if (type === "delta") {
            on.onDelta(data.text || "");
            continue;
          }
          const payload = data?.payload ?? {};
          const settled = dispatchDurableEvent(type, payload, on);
          if (!settled) continue;
          const st = settled.status;
          if (st === "failed") throw new Error(payload.error || "the execution failed");
          if (st === "interrupted") throw new Error("the sidecar restarted while this execution was in flight");
          if ((st === "completed" || st === "cancelled") && payload.work_result_id) {
            result = {
              status: st,
              message_id: payload.message_id,
              work_result_id: payload.work_result_id,
              stopped: payload.stopped === true,
              metrics: payload.metrics,
              last_seq: lastSeq,
            };
          } else if (st === "cancelled" && !result) {
            result = { status: st, stopped: true, last_seq: lastSeq };
          }
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* already closed/aborted */
      }
    }
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (!result) throw new StreamDisconnectedError(lastSeq, "stream ended without completion");
    return result;
  } catch (e) {
    if (signal?.aborted) throw e;
    if (e instanceof StreamDisconnectedError) throw e;
    const msg = String((e as Error)?.message ?? e);
    const status = (e as { status?: number }).status;
    // Terminal HTTP errors (missing execution, validation) are not reconnectable.
    if (status === 404 || status === 422 || status === 409) throw e;
    if (/the execution failed|sidecar restarted/i.test(msg)) throw e;
    throw new StreamDisconnectedError(lastSeq, msg);
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }
}

/** Reconnect a dropped durable event stream at `after=<last seq>` until the
 * execution settles or the caller aborts. This is the only recovery path —
 * there is no blocking POST fallback. */
export async function followExecutionEvents(
  taskId: string,
  executionId: string,
  on: LiveEventHandlers,
  opts: { signal?: AbortSignal; after?: number } = {},
): Promise<ExecutionStreamResult> {
  let after = opts.after ?? 0;
  let attempt = 0;
  while (!opts.signal?.aborted) {
    try {
      return await streamExecutionEvents(
        taskId, executionId,
        {
          ...on,
          onSeq: (seq) => {
            after = seq;
            on.onSeq?.(seq);
          },
        },
        { signal: opts.signal, after },
      );
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      if (!(e instanceof StreamDisconnectedError)) throw e;
      after = e.lastSeq;
      attempt += 1;
      if (attempt > STREAM_RECONNECT_MAX) throw e;
      await sleep(Math.min(8000, 250 * 2 ** Math.min(attempt, 5)));
    }
  }
  throw new DOMException("Aborted", "AbortError");
}
