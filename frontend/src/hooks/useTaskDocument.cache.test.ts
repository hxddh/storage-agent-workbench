/**
 * Cache restore must not count as a successful server load. Revisit + failed
 * refresh has to surface loadError instead of keeping a stale document.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { useTaskDocument } from "./useTaskDocument";
import type { TaskRecord } from "../types";
import type { TFunc } from "../i18n";

const api = vi.hoisted(() => ({
  getTaskRecord: vi.fn(),
  getTaskMessages: vi.fn(),
  getTaskOverview: vi.fn(),
  getTaskTriage: vi.fn(),
  getTaskState: vi.fn(),
  followExecutionEvents: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, ...api };
});

vi.mock("../liveTasks", () => ({
  getLiveTask: () => ({ busy: false }),
  useLiveTask: () => ({ busy: false, taskStatus: null }),
  patchLiveTask: vi.fn(),
}));

const t = ((key: string) => key) as unknown as TFunc;

function detail(id: string): TaskRecord {
  return {
    id,
    title: id,
    goal: null,
    provider_id: null,
    primary_bucket: null,
    status: "ready",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    runs: [],
    findings: [],
    summary: null,
    messages: [],
    message_total: 0,
  };
}

function mount(taskId: string | null) {
  return renderHook(
    ({ id }: { id: string | null }) =>
      useTaskDocument({
        taskId: id,
        sidecarReady: false,
        reloadKey: 0,
        t,
        scrollRef: createRef<HTMLDivElement>(),
        setViewError: () => undefined,
      }),
    { initialProps: { id: taskId } },
  );
}

describe("useTaskDocument cache vs server load", () => {
  beforeEach(() => {
    api.getTaskRecord.mockReset();
    api.getTaskOverview.mockReset();
    api.getTaskTriage.mockReset();
    api.getTaskState.mockReset();
    api.getTaskTriage.mockResolvedValue({ cases: [] });
    api.getTaskState.mockResolvedValue({
      task_id: "x",
      status: "ready",
      active_execution: null,
      last_event_seq: 0,
      last_execution: null,
      queued_executions: [],
      pending_decisions: [],
      context_version: 0,
    });
    api.getTaskOverview.mockResolvedValue({ turns: [] });
  });

  it("reports a refresh error after revisiting a cached task", async () => {
    api.getTaskRecord.mockImplementation(async (id: string) => detail(id));
    const { result, rerender } = mount("task-a");
    await waitFor(() => expect(result.current.detail?.id).toBe("task-a"));

    rerender({ id: "task-b" });
    await waitFor(() => expect(result.current.detail?.id).toBe("task-b"));

    api.getTaskRecord.mockRejectedValueOnce(new Error("session not found"));
    rerender({ id: "task-a" });
    await waitFor(() => expect(result.current.loadError).toBeTruthy());
    expect(result.current.detail).toBeNull();
  });

  it("keeps a successfully loaded document when a later refresh fails", async () => {
    api.getTaskRecord.mockImplementation(async (id: string) => detail(id));
    const { result, rerender } = renderHook(
      ({ id, reloadKey }: { id: string | null; reloadKey: number }) =>
        useTaskDocument({
          taskId: id,
          sidecarReady: false,
          reloadKey,
          t,
          scrollRef: createRef<HTMLDivElement>(),
          setViewError: () => undefined,
        }),
      { initialProps: { id: "task-keep", reloadKey: 0 } },
    );
    await waitFor(() => expect(result.current.detail?.id).toBe("task-keep"));

    const callsBefore = api.getTaskRecord.mock.calls.length;
    api.getTaskRecord.mockRejectedValueOnce(new Error("temporary"));
    rerender({ id: "task-keep", reloadKey: 1 });
    await waitFor(() => expect(api.getTaskRecord.mock.calls.length).toBeGreaterThan(callsBefore));
    expect(result.current.detail?.id).toBe("task-keep");
    expect(result.current.loadError).toBeNull();
  });
});
