import { createContext, useContext } from "react";
import type { TaskProvenance } from "../viz/types";
import type { Conclusion } from "../types";
import type { ArtifactKind, ArtifactSelection } from "./model";
import type { ArtifactsProjection } from "./useAgentTaskProjection";

/**
 * v3.0 — the Task's durable outputs (Evidence · Report · Execution): a quiet
 * bar under the Result names them, and the inspector on the right opens
 * them. The shell owns which one is open and what exists; the document
 * reports whether it has a Result (the Report needs one).
 */
export type TaskDetailsState = {
  taskId: string | null;
  /** The expanded row (and, with an id, the one document open in it). */
  selection: ArtifactSelection | null;
  projection: ArtifactsProjection;
  provenance: TaskProvenance | null;
  open: (kind: ArtifactKind, id?: string | null) => void;
  back: () => void;
  close: () => void;
  /** The document has a Work Result (so the task has a Report). */
  hasResult: boolean;
  setHasResult: (value: boolean) => void;
  /** v3.1 — the latest recorded conclusion, so the Evidence pane lists the
   * same findings the Result does. */
  conclusion: Conclusion | null;
  setConclusion: (value: Conclusion | null) => void;
};

const EMPTY_PROJECTION: ArtifactsProjection = {
  detail: null, executions: [], report: null, reportLoading: false, error: null,
};

export const TaskDetailsContext = createContext<TaskDetailsState>({
  taskId: null,
  selection: null,
  projection: EMPTY_PROJECTION,
  provenance: null,
  open: () => undefined,
  back: () => undefined,
  close: () => undefined,
  hasResult: false,
  setHasResult: () => undefined,
  conclusion: null,
  setConclusion: () => undefined,
});

export function useTaskDetails(): TaskDetailsState {
  return useContext(TaskDetailsContext);
}
