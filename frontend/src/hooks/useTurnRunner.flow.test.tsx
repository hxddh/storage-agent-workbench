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
