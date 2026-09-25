import { useEffect, useMemo, useReducer, useState, type ReactNode } from "react";
import { publishAgentCommands } from "./commands";
import { agentShellReducer, initialAgentShellState } from "./model";
import { TaskDetailsContext, type TaskDetailsState } from "./taskDetails";
import { useAgentTaskProjection } from "./useAgentTaskProjection";
import { useTaskProvenance } from "../hooks/useTaskProvenance";
import { useLiveTask } from "../liveTasks";

/**
 * The active task environment: one Task document. v2.0 — the durable outputs
 * are not a side panel any more; the shell owns which of them is expanded
 * (the document renders them under the Result) and publishes the one command
 * target the menu, the keyboard and the document use. No header, no strip,
 * no second presentation mode.
 */
export function AgentShell({
  taskContent,
  taskId,
}: {
  taskContent: ReactNode;
  taskId: string | null;
}) {
  const [state, dispatch] = useReducer(agentShellReducer, taskId, (id) => initialAgentShellState(id));
  const run = useLiveTask(taskId ?? "");
  const [reloadKey, setReloadKey] = useState(0);
  const expanded = state.artifactsOpen && Boolean(taskId);
  // The rows list what exists, so they load with the task, not on demand.
  const projection = useAgentTaskProjection(taskId, Boolean(taskId), expanded ? state.selection : null, reloadKey);
  const provenance = useTaskProvenance(taskId, Boolean(taskId));

  useEffect(() => {
    dispatch({ type: "task.changed", taskId });
  }, [taskId]);

  // Durable outputs change when the task's execution settles: re-read them.
  useEffect(() => {
    if (!run.busy) setReloadKey((key) => key + 1);
  }, [run.busy]);

  useEffect(() => publishAgentCommands((command) => dispatch(command)), []);

  const details = useMemo<TaskDetailsState>(() => ({
    taskId,
    selection: expanded ? state.selection : null,
    projection,
    provenance,
    open: (kind, id) => dispatch({ type: "artifacts.open", kind, id: id ?? null }),
    back: () => dispatch({ type: "artifacts.back" }),
    close: () => dispatch({ type: "artifacts.close" }),
  }), [taskId, expanded, state.selection, projection, provenance]);

  return (
    <div
      data-testid="agent-shell"
      data-details={expanded ? state.selection?.kind ?? "evidence" : "closed"}
      className="native-task-area"
    >
      <TaskDetailsContext.Provider value={details}>
        <section className="agent-task-content" data-testid="agent-task-content" data-empty={taskId ? "false" : "true"}>
          {taskContent}
        </section>
      </TaskDetailsContext.Provider>
    </div>
  );
}
