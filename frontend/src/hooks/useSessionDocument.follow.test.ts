/**
 * v1.12 push transport: while a follower is open the document reads the
 * task's status from `task.status` frames and never polls `/state` on an
 * interval — once on attach, once on a visibility change, once when the
 * follower ends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { createRef } from "react";
import type { LiveEventHandlers, TaskState } from "../api";
import type { TFunc } from "../i18n";
import type { SessionDetail } from "../types";
import { dropSessionRun, getSessionRun } from "../sessionRuns";
import { useSessionDocument } from "./useSessionDocument";

const api = vi.hoisted(() => ({
  getSession: vi.fn(),
  getSessionMessages: vi.fn(),
  getSessionOverview: vi.fn(),
  getSessionTriage: vi.fn(),
  getTaskState: vi.fn(),
  followExecutionEvents: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, ...api };
});

const t = ((key: string) => key) as unknown as TFunc;
const TASK = "follow-task";

// One persisted message: an EMPTY document gets one bounded recheck reload
// (the reload-after-Stop race), which is not the interval this test guards.
const detail = (id: string): SessionDetail => ({
  id, title: id, goal: null, provider_id: null, primary_bucket: null, status: "ready",
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  runs: [], findings: [], summary: null, message_total: 1,
  messages: [{
    id: "u1", role: "user", content: "check the bucket", referenced_run_ids: [], referenced_evidence_ids: [],
    created_at: "2026-01-01T00:00:00Z",
  }],
});

const running = (): TaskState => ({
  task_id: TASK, status: "working",
  active_execution: {
    id: "e1", task_id: TASK, turn_id: null, direction: "check the bucket", kind: "direction", status: "running",
    error: null, resumed_from: null, steer_count: 0, work_result_id: null,
    created_at: "2026-01-01T00:00:00Z", started_at: new Date().toISOString(), finished_at: null,
  },
  last_event_seq: 3, last_execution: null, queued_executions: [], pending_decisions: [], context_version: 1,
});

const flush = () => act(async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
});

describe("useSessionDocument while a follower is open", () => {
  let handlers: LiveEventHandlers | null = null;
  let settle: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    handlers = null;
    settle = null;
    api.getSession.mockReset().mockImplementation(async (id: string) => detail(id));
    api.getSessionTriage.mockReset().mockResolvedValue({ cases: [] });
    api.getSessionOverview.mockReset().mockResolvedValue({ turns: [] });
    api.getTaskState.mockReset().mockImplementation(async () => running());
    api.followExecutionEvents.mockReset().mockImplementation(
      (_task: string, _exec: string, on: LiveEventHandlers) => new Promise<{ status: string; stopped: boolean; last_seq: number }>((resolve) => {
        handlers = on;
        settle = () => resolve({ status: "completed", stopped: false, last_seq: 9 });
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    dropSessionRun(TASK);
  });

  it("polls /state once on attach, then only on visibility change and on end", async () => {
    const { result } = renderHook(() => useSessionDocument({
      sessionId: TASK, sidecarReady: true, reloadKey: 0, t,
      scrollRef: createRef<HTMLDivElement>(), setViewError: () => undefined,
    }));
    await flush();
    await flush();
    expect(api.followExecutionEvents).toHaveBeenCalledTimes(1);
    expect(getSessionRun(TASK).busy).toBe(true);
    const onAttach = api.getTaskState.mock.calls.length;
    expect(onAttach).toBeGreaterThan(0);

    // No interval: twenty seconds of an idle follower issue zero reads.
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(api.getTaskState).toHaveBeenCalledTimes(onAttach);
    expect(api.followExecutionEvents).toHaveBeenCalledTimes(1);

    // The queue and pending set arrive on the stream and reach the document.
    act(() => {
      handlers?.onTaskStatus?.({
        status: "working", active_execution_id: "e1",
        queued: [{ id: "e2", direction: "then the ACL", kind: "direction", created_at: "2026-01-01T00:02:00Z" }],
        pending_decisions: [], last_execution: null,
      });
    });
    await flush();
    expect(result.current.taskRuntime?.queued_executions.map((q) => q.id)).toEqual(["e2"]);
    expect(api.getTaskState).toHaveBeenCalledTimes(onAttach);

    // A visibility change is one read.
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await flush();
    expect(api.getTaskState).toHaveBeenCalledTimes(onAttach + 1);

    // The follower ends: one discovery read, no interval afterwards.
    api.getTaskState.mockImplementation(async () => ({
      ...running(), status: "ready", active_execution: null,
      last_execution: { ...running().active_execution!, status: "completed" },
    }));
    act(() => { settle?.(); });
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    await flush();
    const afterEnd = api.getTaskState.mock.calls.length;
    expect(afterEnd).toBeGreaterThan(onAttach + 1);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    // At most the one bounded "look once more for a queued follow-up" read.
    expect(api.getTaskState.mock.calls.length).toBeLessThanOrEqual(afterEnd + 1);
    expect(getSessionRun(TASK).busy).toBe(false);
  });
});
