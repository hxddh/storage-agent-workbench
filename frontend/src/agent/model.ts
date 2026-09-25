/**
 * The Task's durable outputs (Evidence · Report · Plans · Baselines & Drift ·
 * Execution), shown as detail rows under the Result that expand in place
 * (v2.0; formerly a right split panel). `artifactsOpen` + `selection` name the
 * one expanded row and the document open in it.
 */
export type ArtifactKind = "evidence" | "report" | "execution";

export const ARTIFACT_KINDS: readonly ArtifactKind[] = ["evidence", "report", "execution"];

/** What the panel is pointed at. `id` names a document inside the panel;
 * without an id the panel shows the section list (scrolled to `kind`). */
export type ArtifactSelection = {
  kind: ArtifactKind;
  id: string | null;
  findingId: string | null;
};

export type AgentShellState = {
  artifactsOpen: boolean;
  selection: ArtifactSelection | null;
  taskId: string | null;
};

export type AgentShellAction =
  | { type: "task.changed"; taskId: string | null }
  | { type: "artifacts.open"; kind: ArtifactKind; id?: string | null; findingId?: string | null }
  | { type: "artifacts.toggle" }
  | { type: "artifacts.close" }
  | { type: "artifacts.back" };

export function initialAgentShellState(taskId: string | null, artifactsOpen = false): AgentShellState {
  return { artifactsOpen, selection: null, taskId };
}

/** The Report is a single document per task: opening the kind opens it. */
export function selectionOpensDocument(selection: ArtifactSelection | null): boolean {
  if (!selection) return false;
  return selection.kind === "report" || Boolean(selection.id);
}

function sameListSelection(a: ArtifactSelection | null, b: ArtifactSelection): boolean {
  return Boolean(a) && a!.kind === b.kind && !a!.id && !b.id && !a!.findingId && !b.findingId;
}

export function agentShellReducer(state: AgentShellState, action: AgentShellAction): AgentShellState {
  switch (action.type) {
    case "task.changed":
      // Another task opens on its Result with every detail row folded.
      return { ...state, taskId: action.taskId, artifactsOpen: false, selection: null };
    case "artifacts.open": {
      if (!state.taskId) return state;
      const next: ArtifactSelection = { kind: action.kind, id: action.id ?? null, findingId: action.findingId ?? null };
      // Pressing the same plain section again while it is already showing
      // closes the panel — the one keyboard entry (⌘I) toggles.
      if (state.artifactsOpen && !selectionOpensDocument(next) && sameListSelection(state.selection, next)) {
        return { ...state, artifactsOpen: false, selection: null };
      }
      return { ...state, artifactsOpen: true, selection: next };
    }
    case "artifacts.toggle":
      if (!state.taskId) return state;
      return state.artifactsOpen
        ? { ...state, artifactsOpen: false, selection: null }
        : { ...state, artifactsOpen: true, selection: state.selection ?? { kind: "evidence", id: null, findingId: null } };
    case "artifacts.close":
      return { ...state, artifactsOpen: false, selection: null };
    case "artifacts.back":
      return state.selection
        ? { ...state, selection: { kind: state.selection.kind, id: null, findingId: null } }
        : state;
  }
}
