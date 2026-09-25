import { createContext, useContext } from "react";
import type { TaskProvenance } from "../viz/types";
import type { ArtifactKind, ArtifactSelection } from "./model";
import type { ArtifactsProjection } from "./useAgentTaskProjection";

/**
 * v2.0 — the Task's durable outputs (Evidence · Report · Execution · Plans ·
 * Baselines & Drift) live IN the document, under the Result, as rows that
 * expand in place. The shell owns which row is open and what the rows list;
 * the document renders them. There is no side panel.
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
};

const EMPTY_PROJECTION: ArtifactsProjection = {
  detail: null, executions: [], plans: [], baselines: [], report: null, reportLoading: false, error: null,
};

export const TaskDetailsContext = createContext<TaskDetailsState>({
  taskId: null,
  selection: null,
  projection: EMPTY_PROJECTION,
  provenance: null,
  open: () => undefined,
  back: () => undefined,
  close: () => undefined,
});

export function useTaskDetails(): TaskDetailsState {
  return useContext(TaskDetailsContext);
}
