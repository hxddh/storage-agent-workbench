import { describe, expect, it } from "vitest";
import type { LiveTask } from "../liveTasks";
import { agentTaskState } from "./taskState";

const run = (patch: Partial<LiveTask> = {}): LiveTask => ({
  busy: false,
  uploading: false,
  pending: null,
  items: [],
  answer: null,
  conclusion: null,
  startedAt: null,
  lastMetrics: null,
  taskStatus: null,
  contextTokens: null,
  needKey: false,
  error: null,
  stopped: false,
  stalled: false,
  failedText: null,
  ...patch,
});

describe("Agent task state", () => {
  it("distinguishes an empty delegate surface from an existing ready task", () => {
    expect(agentTaskState(run(), false)).toBe("idle");
    expect(agentTaskState(run(), true)).toBe("ready");
  });

  it("treats runtime errors, missing model and stalled execution as attention", () => {
    expect(agentTaskState(run({ error: "boom" }), true)).toBe("attention");
    expect(agentTaskState(run({ needKey: true }), true)).toBe("attention");
    expect(agentTaskState(run({ stalled: true }), true)).toBe("attention");
  });

  it("keeps evidence preparation ahead of other states", () => {
    expect(agentTaskState(run({ uploading: true, busy: true }), true)).toBe("uploading");
  });

  it("reports a DURABLE working execution with a cold browser run store", () => {
    // A reload, a second window, another client's delegation: the Sidecar's
    // task runtime says work is executing even though this browser saw none of
    // it start. The durable status must win over an idle-looking run store.
    expect(agentTaskState(run(), true, "working")).toBe("working");
  });

  it("projects the durable lifecycle when the run store is cold — never a decision (v2.1)", () => {
    expect(agentTaskState(run(), true, "needs_attention")).toBe("attention");
    expect(agentTaskState(run(), true, "ready")).toBe("ready");
    // A pre-2.1 row reads as ready, not as a state that waits for the user.
    expect(agentTaskState(run(), true, "needs_decision")).toBe("ready");
  });

  it("keeps live browser truth ahead of a stale durable status", () => {
    expect(agentTaskState(run({ uploading: true }), true, "working")).toBe("uploading");
    expect(agentTaskState(run({ busy: true }), true, "needs_attention")).toBe("working");
  });
});
