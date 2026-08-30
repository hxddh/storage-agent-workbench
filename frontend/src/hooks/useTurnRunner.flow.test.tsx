/**
 * Integration tests for the turn-runner flow with the api module mocked. These
 * exercise the v0.38 state-machine fixes end-to-end (rather than a pure helper):
 *
 *  FE2  a turn that fails while the user is viewing ANOTHER session stashes the
 *       message as failedText (restored on return) instead of losing it; a
 *       failure on the VISIBLE session restores it straight into the composer.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { createElement, useRef, type ReactNode } from "react";
import { useTurnRunner } from "./useTurnRunner";
import { getSessionRun } from "../sessionRuns";
import { I18nProvider } from "../i18n";

// The hook calls useI18n(), so every render needs the provider.
const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(I18nProvider, null, children);

// --- api module mock ---------------------------------------------------------
const api = vi.hoisted(() => ({
  createSession: vi.fn(),
  getSession: vi.fn(),
  postSessionMessage: vi.fn(),
  streamSessionMessage: vi.fn(),
  cancelSessionTurn: vi.fn(),
  uploadSessionDataset: vi.fn(),
  submitErrorTriage: vi.fn(),
  deleteSession: vi.fn(),
  // Durable task runtime transport (v0.94).
  createTaskExecution: vi.fn(),
  streamExecutionEvents: vi.fn(),
  steerTaskExecution: vi.fn(),
  stopTaskExecution: vi.fn(),
  getSessionTurnState: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, ...api };
});

// A harness that gives the hook a real localId ref we can flip mid-turn.
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
  // Default: the durable submit fails so legacy tests exercise the blocking
  // fallback exactly as before; individual tests override for the happy path.
  api.createTaskExecution.mockRejectedValue(new Error("stream broke"));
  api.streamExecutionEvents.mockRejectedValue(new Error("stream broke"));
  api.getSessionTurnState.mockResolvedValue({ running: false });
});

describe("the durable execution path", () => {
  it("delegates via a durable execution and follows its event stream", async () => {
    const id = "sessD";
    api.createTaskExecution.mockResolvedValue({ execution: { id: "exec-1" }, created: true });
    api.streamExecutionEvents.mockResolvedValue({
      status: "completed", stopped: false, message_id: "m1",
      proposed_actions: [], metrics: { duration_ms: 10, tool_calls: 0 }, last_seq: 5,
    });

    const { result } = renderHook(() => useHarness(id), { wrapper });
    result.current.localId.current = id;
    await act(async () => {
      await result.current.runner.submit("check the bucket");
    });

    expect(api.createTaskExecution).toHaveBeenCalledWith(id, "check the bucket", expect.any(String));
    expect(api.streamExecutionEvents).toHaveBeenCalledWith(
      id, "exec-1", expect.anything(), expect.anything());
    // The legacy stream endpoint is no longer part of the submit path at all.
    expect(api.streamSessionMessage).not.toHaveBeenCalled();
    expect(api.postSessionMessage).not.toHaveBeenCalled();
    expect(getSessionRun(id).busy).toBe(false);
    expect(getSessionRun(id).lastMetrics?.messageId).toBe("m1");
  });

  it("steers the CURRENT execution instead of cancelling it", async () => {
    const id = "sessS";
    api.steerTaskExecution.mockResolvedValue({ status: "steering", execution: { id: "exec-2" } });
    const { result } = renderHook(() => useHarness(id), { wrapper });
    result.current.localId.current = id;
    // An execution is live for this task (e.g. reattached after a reload).
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
    api.getSessionTurnState.mockResolvedValue({ running: true, execution_id: "exec-3" });
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
    patchSessionRun(id, { busy: false });
  });
});

describe("turn failure while viewing another session (FE2)", () => {
  it("stashes the message as failedText instead of losing it", async () => {
    const id = "sessX";
    // The stream fails NOT via abort, so it falls back to blocking; the blocking
    // call reports 'no model provider' AND the user has navigated away by then.
    api.streamSessionMessage.mockRejectedValue(new Error("stream broke"));
    api.postSessionMessage.mockImplementation(async () => {
      throw new Error("no model provider configured");
    });

    const { result } = renderHook(() => useHarness(id), { wrapper });
    // Simulate the user switching to another session mid-turn: flip localId.
    result.current.localId.current = id;
    api.postSessionMessage.mockImplementationOnce(async () => {
      result.current.localId.current = "other-session";
      throw new Error("no model provider configured");
    });

    await act(async () => {
      await result.current.runner.submit("my important question");
    });

    // The message is NOT in this session's composer (we're not viewing it)...
    expect(result.current.setText).not.toHaveBeenCalledWith("my important question");
    // ...it's stashed as failedText for restoration on return.
    expect(getSessionRun(id).failedText).toBe("my important question");
    expect(getSessionRun(id).pending).toBeNull();
    expect(getSessionRun(id).busy).toBe(false);
  });
});

describe("turn failure while viewing THIS session", () => {
  it("restores the message straight into the composer and leaves no failedText", async () => {
    const id = "sessY";
    api.streamSessionMessage.mockRejectedValue(new Error("stream broke"));
    api.postSessionMessage.mockRejectedValue(new Error("no model provider configured"));

    const { result } = renderHook(() => useHarness(id), { wrapper });
    result.current.localId.current = id;

    await act(async () => {
      await result.current.runner.submit("keep me");
    });

    expect(result.current.setText).toHaveBeenCalledWith("keep me");
    expect(getSessionRun(id).failedText).toBeNull();
    expect(getSessionRun(id).needKey).toBe(true);
  });
});

/**
 * Sweeping the empty session a failed FIRST turn left behind must not clear the
 * pointer to a DIFFERENT session.
 *
 * The sweep is async — read the session back, confirm it is empty, delete it —
 * and it used to end with an unconditional `localId.current = null`. A user who
 * switched to another investigation while that was in flight (which is exactly
 * what people do after a turn fails: go back to what was working) had the ref
 * to the session they were now looking at cleared under them, so their next
 * message opened a second, empty conversation instead of continuing theirs.
 */
describe("the empty-session sweep after a failed first turn", () => {
  it("keeps the ref when the user has already switched away", async () => {
    api.createSession.mockResolvedValue({ id: "new1" });
    api.streamSessionMessage.mockRejectedValue(new Error("stream broke"));
    api.postSessionMessage.mockRejectedValue(new Error("no model provider configured"));
    api.deleteSession.mockResolvedValue(undefined);

    const { result } = renderHook(() => useHarness(null), { wrapper });
    // The switch happens while the sweep is reading the session back.
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

    // The dead session really was swept...
    expect(api.deleteSession).toHaveBeenCalledWith("new1");
    // ...and the investigation the user is now in is still the open one.
    expect(result.current.localId.current).toBe("other-session");
  });

  it("still clears the ref when that session is the one on screen", async () => {
    api.createSession.mockResolvedValue({ id: "new2" });
    api.streamSessionMessage.mockRejectedValue(new Error("stream broke"));
    api.postSessionMessage.mockRejectedValue(new Error("no model provider configured"));
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
