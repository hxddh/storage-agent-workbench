/**
 * Integration tests for the turn-runner flow with the api module mocked.
 *
 *  FE2  a turn that fails while the user is viewing ANOTHER session stashes the
 *       message as failedText (restored on return) instead of losing it; a
 *       failure on the VISIBLE session restores it straight into the composer.
 *
 * Stream recovery is `followExecutionEvents` (seq reconnect). There is no
 * blocking POST fallback and no assistant-id poll.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { createElement, useRef, type ReactNode } from "react";
import { useTurnRunner } from "./useTurnRunner";
import { getSessionRun } from "../sessionRuns";
import { I18nProvider } from "../i18n";

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(I18nProvider, null, children);

const api = vi.hoisted(() => ({
  createSession: vi.fn(),
  getSession: vi.fn(),
  postSessionMessage: vi.fn(),
  streamSessionMessage: vi.fn(),
  cancelSessionTurn: vi.fn(),
  uploadSessionDataset: vi.fn(),
  submitErrorTriage: vi.fn(),
  deleteSession: vi.fn(),
  createTaskExecution: vi.fn(),
  followExecutionEvents: vi.fn(),
  streamExecutionEvents: vi.fn(),
  steerTaskExecution: vi.fn(),
  stopTaskExecution: vi.fn(),
  resumeTaskExecution: vi.fn(),
  getTaskState: vi.fn(),
  getSessionTurnState: vi.fn(),
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
    onSessionCreated: () => {},
    onSessionDiscarded: () => {},
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
  api.getSession.mockResolvedValue({ messages: [] });
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
      proposed_actions: [], metrics: { duration_ms: 10, tool_calls: 0 }, last_seq: 5,
    });

    const { result } = renderHook(() => useHarness(id), { wrapper });
    result.current.localId.current = id;
    await act(async () => {
      await result.current.runner.submit("check the bucket");
    });

    expect(api.createTaskExecution).toHaveBeenCalledWith(id, "check the bucket", expect.any(String));
    expect(api.followExecutionEvents).toHaveBeenCalledWith(
      id, "exec-1", expect.anything(), expect.anything());
    expect(api.streamSessionMessage).not.toHaveBeenCalled();
    expect(api.postSessionMessage).not.toHaveBeenCalled();
    expect(api.getSessionTurnState).not.toHaveBeenCalled();
    expect(getSessionRun(id).busy).toBe(false);
    expect(getSessionRun(id).lastMetrics?.messageId).toBe("m1");
  });

  it("steers the CURRENT execution instead of cancelling it", async () => {
    const id = "sessS";
    api.steerTaskExecution.mockResolvedValue({ status: "steering", execution: { id: "exec-2" } });
    const { result } = renderHook(() => useHarness(id), { wrapper });
    result.current.localId.current = id;
    const { patchSessionRun } = await import("../sessionRuns");
    patchSessionRun(id, { busy: true });
    await act(async () => {
      await result.current.runner.steer("focus on us-east-1");
    });
    expect(api.steerTaskExecution).toHaveBeenCalledWith(id, "focus on us-east-1");
    expect(api.cancelSessionTurn).not.toHaveBeenCalled();
    expect(api.stopTaskExecution).not.toHaveBeenCalled();
    patchSessionRun(id, { busy: false });
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
    const { patchSessionRun } = await import("../sessionRuns");
    patchSessionRun(id, { busy: true });
    await act(async () => {
      result.current.runner.stop();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.stopTaskExecution).toHaveBeenCalledWith(id, "exec-3");
    expect(api.getSessionTurnState).not.toHaveBeenCalled();
    patchSessionRun(id, { busy: false });
  });

  it("resumes an interrupted execution and follows the new event stream", async () => {
    const id = "sessResume";
    api.resumeTaskExecution.mockResolvedValue({
      execution: { id: "exec-new", direction: "check the bucket" },
      resumed_from: "exec-old",
    });
    api.followExecutionEvents.mockResolvedValue({
      status: "completed", stopped: false, message_id: "m2",
      proposed_actions: [], last_seq: 3,
    });
    const { result } = renderHook(() => useHarness(id), { wrapper });
    result.current.localId.current = id;
    await act(async () => {
      await result.current.runner.resume("exec-old");
    });
    expect(api.resumeTaskExecution).toHaveBeenCalledWith(id, "exec-old");
    expect(api.followExecutionEvents).toHaveBeenCalledWith(
      id, "exec-new", expect.anything(), expect.anything());
    expect(api.postSessionMessage).not.toHaveBeenCalled();
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
    expect(getSessionRun(id).failedText).toBe("my important question");
    expect(getSessionRun(id).pending).toBeNull();
    expect(getSessionRun(id).busy).toBe(false);
    expect(api.postSessionMessage).not.toHaveBeenCalled();
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
    expect(getSessionRun(id).failedText).toBeNull();
    expect(getSessionRun(id).needKey).toBe(true);
    expect(api.postSessionMessage).not.toHaveBeenCalled();
  });
});

describe("the empty-session sweep after a failed first turn", () => {
  it("keeps the ref when the user has already switched away", async () => {
    api.createSession.mockResolvedValue({ id: "new1" });
    api.deleteSession.mockResolvedValue(undefined);

    const { result } = renderHook(() => useHarness(null), { wrapper });
    api.getSession.mockImplementation(async () => {
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

    expect(api.deleteSession).toHaveBeenCalledWith("new1");
    expect(result.current.localId.current).toBe("other-session");
  });

  it("still clears the ref when that session is the one on screen", async () => {
    api.createSession.mockResolvedValue({ id: "new2" });
    api.deleteSession.mockResolvedValue(undefined);
    api.getSession.mockResolvedValue({ messages: [] });

    const { result } = renderHook(() => useHarness(null), { wrapper });
    await act(async () => {
      await result.current.runner.submit("first question, no key configured");
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.deleteSession).toHaveBeenCalledWith("new2");
    expect(result.current.localId.current).toBeNull();
  });
});
