export type ReviewSurface = "evidence" | "execution" | "report";

export type AgentShellState = {
  review: ReviewSurface | null;
  selectedExecutionId: string | null;
  taskId: string | null;
};

export type AgentShellAction =
  | { type: "task.changed"; taskId: string | null }
  | { type: "review.open"; review: ReviewSurface }
  | { type: "review.close" }
  | { type: "execution.open"; executionId: string }
  | { type: "execution.close" };

export function initialAgentShellState(taskId: string | null): AgentShellState {
  return { review: null, selectedExecutionId: null, taskId };
}

export function agentShellReducer(state: AgentShellState, action: AgentShellAction): AgentShellState {
  switch (action.type) {
    case "task.changed":
      return action.taskId
        ? { ...state, taskId: action.taskId, selectedExecutionId: null }
        : initialAgentShellState(null);
    case "review.open":
      if (!state.taskId) return state;
      return {
        ...state,
        review: action.review,
        selectedExecutionId: action.review === "execution" ? state.selectedExecutionId : null,
      };
    case "review.close":
      return { ...state, review: null, selectedExecutionId: null };
    case "execution.open":
      if (!state.taskId) return state;
      return { ...state, review: "execution", selectedExecutionId: action.executionId };
    case "execution.close":
      return { ...state, selectedExecutionId: null };
  }
}
