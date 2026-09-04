/**
 * `task.status` (v1.12): the durable event stream carries the task's derived
 * status, its queue and its pending Decisions, so a client following an
 * execution no longer polls `/agent-tasks/{id}/state` on an interval. This
 * folds one frame into the `TaskState` shape the document already reads,
 * keeping whatever the last full state knew about the executions it names.
 */
import type { TaskExecution, TaskState, TaskStatusPayload } from "../api";

function stub(taskId: string, id: string, known: TaskExecution | undefined, over: Partial<TaskExecution>): TaskExecution {
  return {
    ...(known ?? {
      id, task_id: taskId, turn_id: null, direction: null, kind: "direction", status: "queued",
      error: null, resumed_from: null, steer_count: 0, work_result_id: null,
      created_at: "", started_at: null, finished_at: null,
    }),
    ...over,
  };
}

export function applyTaskStatus(prev: TaskState | null, taskId: string, payload: TaskStatusPayload): TaskState {
  const known = new Map<string, TaskExecution>();
  for (const execution of [prev?.active_execution, prev?.last_execution, ...(prev?.queued_executions ?? [])]) {
    if (execution) known.set(execution.id, execution);
  }
  const activeId = payload.active_execution_id;
  const active = activeId
    ? stub(taskId, activeId, known.get(activeId), {
        status: payload.status === "needs_decision" ? "waiting"
          : known.get(activeId)?.status === "waiting" && payload.status !== "working" ? "waiting" : "running",
      })
    : null;
  const last = payload.last_execution
    ? stub(taskId, payload.last_execution.id, known.get(payload.last_execution.id), { status: payload.last_execution.status })
    : prev?.last_execution ?? null;
  return {
    task_id: taskId,
    status: payload.status,
    active_execution: active,
    last_event_seq: prev?.last_event_seq ?? 0,
    last_execution: last,
    // GET /agent-tasks already drops the active id from queued_executions.
    // task.status.queued[] still lists a just-submitted row while it is
    // queued, so fold the same way or the live Direction reprints as a banner.
    queued_executions: payload.queued.filter((q) => q.id !== activeId).map((q) => stub(taskId, q.id, known.get(q.id), {
      direction: q.direction, kind: q.kind, created_at: q.created_at, status: "queued",
    })),
    pending_decisions: payload.pending_decisions,
    context_version: prev?.context_version ?? 0,
  };
}
