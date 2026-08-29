import { describe, expect, it } from "vitest";
import { agentShellReducer, initialAgentShellState } from "./model";

describe("v0.93 Agent-native task shell", () => {
  it("starts with one Agent task workspace and no review page", () => {
    expect(initialAgentShellState("task-1")).toEqual({
      review: null,
      selectedExecutionId: null,
      focus: false,
      taskId: "task-1",
    });
  });

  it("does not open contextual review before a task exists", () => {
    const state = initialAgentShellState(null);
    expect(agentShellReducer(state, { type: "review.open", review: "evidence" })).toBe(state);
  });

  it("opens evidence as contextual review instead of replacing the Agent task", () => {
    const state = initialAgentShellState("task-1");
    const next = agentShellReducer(state, { type: "review.open", review: "evidence" });
    expect(next.review).toBe("evidence");
    expect(next.taskId).toBe("task-1");
  });

  it("opens an execution inside Review without inventing a second task surface", () => {
    const next = agentShellReducer(initialAgentShellState("task-1"), {
      type: "execution.open",
      executionId: "execution-9",
    });
    expect(next.review).toBe("execution");
    expect(next.selectedExecutionId).toBe("execution-9");
  });

  it("blank task reset closes review and focus", () => {
    const focused = agentShellReducer(initialAgentShellState("task-1"), { type: "focus.toggle" });
    const reviewing = agentShellReducer(focused, { type: "review.open", review: "report" });
    expect(agentShellReducer(reviewing, { type: "task.changed", taskId: null })).toEqual(initialAgentShellState(null));
  });
});
