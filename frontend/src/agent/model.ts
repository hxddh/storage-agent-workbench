export type ReviewSurface = "overview" | "evidence" | "runs" | "report";

export type AgentShellState = {
  review: ReviewSurface | null;
  selectedRunId: string | null;
  focus: boolean;
  sessionId: string | null;
};

export type AgentShellAction =
  | { type: "session.changed"; sessionId: string | null }
  | { type: "review.open"; review: ReviewSurface }
  | { type: "review.close" }
  | { type: "run.open"; runId: string }
  | { type: "run.close" }
  | { type: "focus.toggle" };

export function initialAgentShellState(sessionId: string | null): AgentShellState {
  return { review: null, selectedRunId: null, focus: false, sessionId };
}

export function agentShellReducer(state: AgentShellState, action: AgentShellAction): AgentShellState {
  switch (action.type) {
    case "session.changed":
      return action.sessionId
        ? { ...state, sessionId: action.sessionId, selectedRunId: null }
        : initialAgentShellState(null);
    case "review.open":
      if (!state.sessionId) return state;
      return { ...state, review: action.review, selectedRunId: action.review === "runs" ? state.selectedRunId : null };
    case "review.close":
      return { ...state, review: null, selectedRunId: null };
    case "run.open":
      if (!state.sessionId) return state;
      return { ...state, review: "runs", selectedRunId: action.runId };
    case "run.close":
      return { ...state, selectedRunId: null };
    case "focus.toggle":
      return { ...state, focus: !state.focus };
  }
}
