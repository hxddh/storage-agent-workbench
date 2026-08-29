import { describe, expect, it } from "vitest";
import { agentShellReducer, initialAgentShellState } from "./model";

describe("v0.93 Agent-native task shell", () => {
  it("starts with one Agent task workspace and no review page", () => {
    expect(initialAgentShellState("s1")).toEqual({
      review: null,
      selectedRunId: null,
      focus: false,
      sessionId: "s1",
    });
  });

  it("does not open contextual review before a task exists", () => {
    const state = initialAgentShellState(null);
    expect(agentShellReducer(state, { type: "review.open", review: "evidence" })).toBe(state);
  });

  it("opens evidence as contextual review instead of replacing the Agent task", () => {
    const state = initialAgentShellState("s1");
    const next = agentShellReducer(state, { type: "review.open", review: "evidence" });
    expect(next.review).toBe("evidence");
    expect(next.sessionId).toBe("s1");
  });

  it("opens an execution inside Review without inventing a second task surface", () => {
    const next = agentShellReducer(initialAgentShellState("s1"), { type: "run.open", runId: "run-9" });
    expect(next.review).toBe("runs");
    expect(next.selectedRunId).toBe("run-9");
  });

  it("blank task reset closes review and focus", () => {
    const focused = agentShellReducer(initialAgentShellState("s1"), { type: "focus.toggle" });
    const reviewing = agentShellReducer(focused, { type: "review.open", review: "report" });
    expect(agentShellReducer(reviewing, { type: "session.changed", sessionId: null })).toEqual(initialAgentShellState(null));
  });
});
