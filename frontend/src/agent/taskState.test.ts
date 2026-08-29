import { describe, expect, it } from "vitest";
import type { SessionRun } from "../sessionRuns";
import { agentTaskState } from "./taskState";

const run = (patch: Partial<SessionRun> = {}): SessionRun => ({
  busy: false,
  uploading: false,
  pending: null,
  streamText: null,
  streamTools: [],
  proposals: null,
  grounding: null,
  lastMetrics: null,
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

  it("surfaces a real confirmation-required proposal as Needs decision", () => {
    expect(agentTaskState(run({
      proposals: [{
        title: "Import bounded evidence",
        reason: "Downloads require confirmation",
        action_type: "run_inventory_analysis",
        requires_confirmation: true,
        confidence: "high",
        source_run_ids: [],
      }],
    }), true)).toBe("decision");
  });

  it("keeps active execution ahead of a stale decision proposal", () => {
    expect(agentTaskState(run({
      busy: true,
      proposals: [{
        title: "Old decision",
        reason: null,
        action_type: "x",
        requires_confirmation: true,
        confidence: "high",
        source_run_ids: [],
      }],
    }), true)).toBe("working");
  });

  it("treats runtime errors, missing model and stalled execution as attention", () => {
    expect(agentTaskState(run({ error: "boom" }), true)).toBe("attention");
    expect(agentTaskState(run({ needKey: true }), true)).toBe("attention");
    expect(agentTaskState(run({ stalled: true }), true)).toBe("attention");
  });

  it("keeps evidence preparation ahead of other states", () => {
    expect(agentTaskState(run({ uploading: true, busy: true }), true)).toBe("uploading");
  });
});
