import { describe, expect, it } from "vitest";
import type { TaskState } from "../api";
import { applyTaskStatus } from "./taskStatus";

const execution = (id: string, status: TaskState["active_execution"] extends infer E ? (E extends { status: infer S } ? S : never) : never) => ({
  id, task_id: "t1", turn_id: null, direction: "check the bucket", kind: "direction", status,
  error: null, resumed_from: null, steer_count: 0, work_result_id: null,
  created_at: "2026-09-01T00:00:00Z", started_at: "2026-09-01T00:00:01Z", finished_at: null,
});

describe("task.status frames", () => {
  it("folds status, queue and pending Decisions into the task state the document reads", () => {
    const prev: TaskState = {
      task_id: "t1", status: "working", active_execution: execution("e1", "running"), last_event_seq: 40,
      last_execution: execution("e1", "running"), queued_executions: [], pending_decisions: [], context_version: 3,
    };
    const next = applyTaskStatus(prev, "t1", {
      status: "needs_decision", active_execution_id: "e1",
      queued: [{ id: "e2", direction: "then check the ACL", kind: "direction", created_at: "2026-09-01T00:01:00Z" }],
      pending_decisions: [{
        id: "d1", task_id: "t1", execution_id: "e1", work_result_id: null, action_type: "import_access_log",
        title: "Download logs", reason: null, kind: "approval", status: "pending", resolution_note: null,
        created_at: "2026-09-01T00:00:30Z", resolved_at: null,
      }],
      last_execution: { id: "e1", status: "waiting" },
    });
    expect(next.status).toBe("needs_decision");
    expect(next.active_execution).toMatchObject({ id: "e1", status: "waiting", direction: "check the bucket" });
    expect(next.queued_executions).toEqual([expect.objectContaining({ id: "e2", direction: "then check the ACL", status: "queued" })]);
    expect(next.pending_decisions.map((d) => d.id)).toEqual(["d1"]);
    expect(next.last_event_seq).toBe(40);
    expect(next.context_version).toBe(3);
  });

  it("builds a usable state from a frame alone when nothing was loaded yet", () => {
    const next = applyTaskStatus(null, "t9", {
      status: "ready", active_execution_id: null, queued: [], pending_decisions: [],
      last_execution: { id: "e7", status: "completed" },
    });
    expect(next.active_execution).toBeNull();
    expect(next.last_execution).toMatchObject({ id: "e7", status: "completed", task_id: "t9" });
    expect(next.queued_executions).toEqual([]);
  });

  it("does not reprint the live Direction as a queued banner", () => {
    const next = applyTaskStatus(null, "t1", {
      status: "working", active_execution_id: "e1",
      queued: [{ id: "e1", direction: "check the bucket", kind: "direction", created_at: "2026-09-01T00:00:00Z" }],
      pending_decisions: [], last_execution: { id: "e1", status: "queued" },
    });
    expect(next.active_execution).toMatchObject({ id: "e1" });
    expect(next.queued_executions).toEqual([]);
  });
});
