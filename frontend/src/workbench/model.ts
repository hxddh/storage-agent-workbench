export type WorkSurface = "timeline" | "evidence" | "runs" | "report";
export type SurfaceMode = "workspace" | "focus";

export interface WorkbenchState {
  surface: WorkSurface;
  mode: SurfaceMode;
  selectedRunId: string | null;
  sessionId: string | null;
}

export type WorkbenchAction =
  | { type: "session.changed"; sessionId: string | null }
  | { type: "surface.open"; surface: WorkSurface }
  | { type: "surface.focus" }
  | { type: "surface.restore" }
  | { type: "run.open"; runId: string }
  | { type: "run.close" };

export function initialWorkbenchState(sessionId: string | null): WorkbenchState {
  return {
    surface: "timeline",
    mode: "workspace",
    selectedRunId: null,
    sessionId,
  };
}

export function workbenchReducer(state: WorkbenchState, action: WorkbenchAction): WorkbenchState {
  switch (action.type) {
    case "session.changed":
      return {
        ...state,
        sessionId: action.sessionId,
        // A new investigation is a new document. Never strand the reader in a
        // report or run that belongs to the previous session.
        surface: action.sessionId ? state.surface : "timeline",
        selectedRunId: null,
      };
    case "surface.open":
      if (!state.sessionId && action.surface !== "timeline") return state;
      return {
        ...state,
        surface: action.surface,
        selectedRunId: action.surface === "runs" ? state.selectedRunId : null,
      };
    case "surface.focus":
      return { ...state, mode: "focus" };
    case "surface.restore":
      return { ...state, mode: "workspace" };
    case "run.open":
      if (!state.sessionId) return state;
      return { ...state, surface: "runs", selectedRunId: action.runId };
    case "run.close":
      return { ...state, selectedRunId: null };
    default:
      return state;
  }
}
