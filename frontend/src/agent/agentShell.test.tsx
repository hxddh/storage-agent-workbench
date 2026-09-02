import { describe, expect, it } from "vitest";
import { agentShellReducer, initialAgentShellState, selectionOpensDocument } from "./model";

describe("v1.11.0 Agent shell: one task document and the Artifacts panel", () => {
  it("starts closed with no selection", () => {
    expect(initialAgentShellState("task-1")).toEqual({ artifactsOpen: false, selection: null, taskId: "task-1" });
  });

  it("does nothing before a task exists", () => {
    const state = initialAgentShellState(null);
    expect(agentShellReducer(state, { type: "artifacts.open", kind: "evidence" })).toBe(state);
    expect(agentShellReducer(state, { type: "artifacts.toggle" })).toBe(state);
  });

  it("opens a section beside the task instead of replacing it", () => {
    const next = agentShellReducer(initialAgentShellState("task-1"), { type: "artifacts.open", kind: "evidence", findingId: "f1" });
    expect(next.artifactsOpen).toBe(true);
    expect(next.selection).toEqual({ kind: "evidence", id: null, findingId: "f1" });
    expect(next.taskId).toBe("task-1");
    expect(selectionOpensDocument(next.selection)).toBe(false);
  });

  it("opens one execution as a document inside the panel and goes back to the list", () => {
    const opened = agentShellReducer(initialAgentShellState("task-1"), { type: "artifacts.open", kind: "execution", id: "execution-9" });
    expect(opened.selection).toEqual({ kind: "execution", id: "execution-9", findingId: null });
    expect(selectionOpensDocument(opened.selection)).toBe(true);
    const back = agentShellReducer(opened, { type: "artifacts.back" });
    expect(back.artifactsOpen).toBe(true);
    expect(back.selection).toEqual({ kind: "execution", id: null, findingId: null });
  });

  it("treats the Report as one document per task", () => {
    const opened = agentShellReducer(initialAgentShellState("task-1"), { type: "artifacts.open", kind: "report" });
    expect(selectionOpensDocument(opened.selection)).toBe(true);
  });

  it("toggles with ⌘I and remembers the open preference across a task switch", () => {
    const open = agentShellReducer(initialAgentShellState("task-1"), { type: "artifacts.toggle" });
    expect(open.artifactsOpen).toBe(true);
    expect(open.selection?.kind).toBe("evidence");
    const switched = agentShellReducer(open, { type: "task.changed", taskId: "task-2" });
    expect(switched.artifactsOpen).toBe(true);
    expect(switched.selection).toBeNull();
    const closed = agentShellReducer(switched, { type: "artifacts.toggle" });
    expect(closed.artifactsOpen).toBe(false);
    expect(closed.selection).toBeNull();
  });

  it("closes explicitly", () => {
    const open = agentShellReducer(initialAgentShellState("task-1"), { type: "artifacts.open", kind: "plan", id: "p1" });
    expect(agentShellReducer(open, { type: "artifacts.close" })).toEqual({ artifactsOpen: false, selection: null, taskId: "task-1" });
  });
});
