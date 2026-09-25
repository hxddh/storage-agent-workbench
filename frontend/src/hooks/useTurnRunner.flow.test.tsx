/**
 * Integration tests for the turn-runner flow with the api module mocked.
 *
 *  FE2  a turn that fails while the user is viewing ANOTHER session stashes the
 *       message as failedText (restored on return) instead of losing it; a
 *       failure on the VISIBLE session restores it straight into the composer.
 *
 * Stream recovery is `followExecutionEvents` (seq reconnect). There is no
 * blocking POST fallback, no turn-cancel endpoint, and no assistant-id poll:
 * `stopTaskExecution` is the one cancel path (v1.12).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { createElement, useRef, type ReactNode } from "react";
import { useTurnRunner } from "./useTurnRunner";
import { getLiveTask } from "../liveTasks";
import { I18nProvider } from "../i18n";

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(I18nProvider, null, children);

const api = vi.hoisted(() => ({
  createTask: vi.fn(),
  getTaskRecord: vi.fn(),
  uploadTaskDataset: vi.fn(),
  submitErrorTriage: vi.fn(),
  deleteTask: vi.fn(),
  createTaskExecution: vi.fn(),
  followExecutionEvents: vi.fn(),
  streamExecutionEvents: vi.fn(),
  steerTaskExecution: vi.fn(),
  stopTaskExecution: vi.fn(),
  resumeTaskExecution: vi.fn(),
  getTaskState: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, ...api };
});

function useHarness(initialId: string | null, onFail?: (v: string) => void) {
  const localId = useRef<string | null>(initialId);
  const setText = vi.fn();
  const runner = useTurnRunner({
    getText: () => "",
    localId,
    onTaskCreated: () => {},
    onTaskDiscarded: () => {},
    reload: vi.fn(async () => true),
    onChanged: () => {},
    setText,
    setViewError: (m) => onFail?.(m ?? ""),
    onUploaded: () => {},
  });
  return { runner, localId, setText };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getTaskRecord.mockResolvedValue({ messages: [] });
  api.getTaskState.mockResolvedValue({
    active_execution: null, last_execution: null, queued_executions: [], pending_decisions: [],
  });
  api.createTaskExecution.mockRejectedValue(new Error("no model provider configured"));
  api.followExecutionEvents.mockRejectedValue(new Error("no model provider configured"));
});

describe("the durable execution path", () => {
  it("delegates via a durable execution and follows its event stream", async () => {
    const id = "sessD";
    api.createTaskExecution.mockResolvedValue({ execution: { id: "exec-1" }, created: true });
    api.followExecutionEvents.mockResolvedValue({
      status: "completed", stopped: false, message_id: "m1",
      metrics: { duration_ms: 10, tool_calls: 0 }, last_seq: 5,
    });

    const { result } = renderHook(() => useHarness(id), { wrapper });
    result.current.localId.current = id;
    await act(async () => {
      await result.current.runner.submit("check the bucket");
    });

    expect(api.createTaskExecution).toHaveBeenCalledWith(id, "check the bucket", expect.any(String));
    expect(api.followExecutionEvents).toHaveBeenCalledWith(
      id, "exec-1", expect.anything(), expect.anything());
    expect(getLiveTask(id).busy).toBe(false);
    expect(getLiveTask(id).lastMetrics?.messageId).toBe("m1");
  });

  it("steers the CURRENT execution instead of cancelling it", async () => {
    const id = "sessS";
    api.steerTaskExecution.mockResolvedValue({ status: "steering", execution: { id: "exec-2" } });
    const { result } = renderHook(() => useHarness(id), { wrapper });
    result.current.localId.current = id;
    const { patchLiveTask } = await import("../liveTasks");
    patchLiveTask(id, { busy: true });
    await act(async () => {
      await result.current.runner.steer("focus on us-east-1");
    });
    expect(api.steerTaskExecution).toHaveBeenCalledWith(id, "focus on us-east-1");
    expect(api.stopTaskExecution).not.toHaveBeenCalled();
    patchLiveTask(id, { busy: false });
  });

  it("stops a reattached execution through its durable identity", async () => {
    const id = "sessR";
    api.getTaskState.mockResolvedValue({
      active_execution: { id: "exec-3", status: "running" },
      last_execution: { id: "exec-3", status: "running" },
      queued_executions: [],
      pending_decisions: [],
    });
    api.stopTaskExecution.mockResolvedValue({ status: "stopping", execution: { id: "exec-3" } });
    const { result } = renderHook(() => useHarness(id), { wrapper });
    result.current.localId.current = id;
    const { patchLiveTask } = await import("../liveTasks");
    patchLiveTask(id, { busy: true });
    await act(async () => {
      result.current.runner.stop();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.stopTaskExecution).toHaveBeenCalledWith(id, "exec-3");
    patchLiveTask(id, { busy: false });
  });

  it("resumes an interrupted execution and follows the new event stream", async () => {
    const id = "sessResume";
    api.resumeTaskExecution.mockResolvedValue({
      execution: { id: "exec-new", direction: "check the bucket" },
      resumed_from: "exec-old",
    });
    api.followExecutionEvents.mockResolvedValue({
      status: "completed", stopped: false, message_id: "m2", last_seq: 3,
    });
    const { result } = renderHook(() => useHarness(id), { wrapper });
    result.current.localId.current = id;
    await act(async () => {
      await result.current.runner.resume("exec-old");
    });
    expect(api.resumeTaskExecution).toHaveBeenCalledWith(id, "exec-old");
    expect(api.followExecutionEvents).toHaveBeenCalledWith(
      id, "exec-new", expect.anything(), expect.anything());
  });
});

describe("the live turn (v1.11)", () => {
  it("reduces stream frames into ordered items and never parks on anything (v2.1)", async () => {
    const id = "sessLive";
    let seen: import("../api").LiveEventHandlers | null = null;
    api.createTaskExecution.mockResolvedValue({ execution: { id: "exec-live" }, created: true });
    api.followExecutionEvents.mockImplementation(async (_id: string, _exec: string, on: import("../api").LiveEventHandlers) => {
      seen = on;
      on.onDelta("Checking the ");
      on.onDelta("policy.");
      on.onMessageCompleted?.({ text: "Checking the policy.", final: false });
      on.onTool({ id: "c1", tool: "import_evidence", target: "access_log:acme-logs", result: "", status: "started" });
      const mid = getLiveTask(id);
      expect(mid.busy).toBe(true);
      expect(mid.items.map((item) => item.kind)).toEqual(["message", "tool"]);
      on.onTool({ id: "c1", tool: "import_evidence", target: "access_log:acme-logs", result: "imported 312 files", ok: true, status: "completed" });
      on.onDelta("The logs show 403s.");
      on.onMessageCompleted?.({ text: "The logs show 403s.", final: true });
      const late = getLiveTask(id);
      expect(late.answer).toBe("The logs show 403s.");
      expect(late.items.map((item) => item.kind)).toEqual(["message", "tool"]);
      return { status: "completed", stopped: false, message_id: "m9", last_seq: 12 };
    });

    const { result } = renderHook(() => useHarness(id), { wrapper });
    result.current.localId.current = id;
    await act(async () => {
      await result.current.runner.submit("import the access logs");
    });
    expect(seen).not.toBeNull();
    expect(getLiveTask(id).busy).toBe(false);
    expect(getLiveTask(id).items).toEqual([]);
    expect(getLiveTask(id).answer).toBeNull();
  });
});

describe("turn failure while viewing another session (FE2)", () => {
  it("stashes the message as failedText instead of losing it", async () => {
    const id = "sessX";
    const { result } = renderHook(() => useHarness(id), { wrapper });
    result.current.localId.current = id;
    api.createTaskExecution.mockImplementationOnce(async () => {
      result.current.localId.current = "other-session";
      throw new Error("no model provider configured");
    });

    await act(async () => {
      await result.current.runner.submit("my important question");
    });

    expect(result.current.setText).not.toHaveBeenCalledWith("my important question");
    expect(getLiveTask(id).failedText).toBe("my important question");
    expect(getLiveTask(id).pending).toBeNull();
    expect(getLiveTask(id).busy).toBe(false);
  });
});

describe("turn failure while viewing THIS session", () => {
  it("restores the message straight into the composer and leaves no failedText", async () => {
    const id = "sessY";
    const { result } = renderHook(() => useHarness(id), { wrapper });
    result.current.localId.current = id;

    await act(async () => {
      await result.current.runner.submit("keep me");
    });

    expect(result.current.setText).toHaveBeenCalledWith("keep me");
    expect(getLiveTask(id).failedText).toBeNull();
    expect(getLiveTask(id).needKey).toBe(true);
  });
});

describe("the empty-session sweep after a failed first turn", () => {
  it("keeps the ref when the user has already switched away", async () => {
    api.createTask.mockResolvedValue({ id: "new1" });
    api.deleteTask.mockResolvedValue(undefined);

    const { result } = renderHook(() => useHarness(null), { wrapper });
    api.getTaskRecord.mockImplementation(async () => {
      result.current.localId.current = "other-session";
      return { messages: [] };
    });

    await act(async () => {
      await result.current.runner.submit("first question, no key configured");
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.deleteTask).toHaveBeenCalledWith("new1");
    expect(result.current.localId.current).toBe("other-session");
  });

  it("still clears the ref when that session is the one on screen", async () => {
    api.createTask.mockResolvedValue({ id: "new2" });
    api.deleteTask.mockResolvedValue(undefined);
    api.getTaskRecord.mockResolvedValue({ messages: [] });

    const { result } = renderHook(() => useHarness(null), { wrapper });
    await act(async () => {
      await result.current.runner.submit("first question, no key configured");
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.deleteTask).toHaveBeenCalledWith("new2");
    expect(result.current.localId.current).toBeNull();
  });
});
