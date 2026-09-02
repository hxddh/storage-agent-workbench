import { useEffect, useReducer, useState, type ReactNode } from "react";
import { publishAgentCommands } from "./commands";
import { ArtifactsPanel } from "./ArtifactsPanel";
import { agentShellReducer, initialAgentShellState } from "./model";
import { useAgentTaskProjection } from "./useAgentTaskProjection";
import { useTaskProvenance } from "../hooks/useTaskProvenance";
import { useSessionRun } from "../sessionRuns";

const ARTIFACTS_KEY = "saw.artifacts.open";
const OVERLAY_BELOW_PX = 960;

function readOpenPreference(): boolean {
  try {
    return localStorage.getItem(ARTIFACTS_KEY) === "1";
  } catch {
    return false;
  }
}

function useNarrowWindow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.innerWidth < OVERLAY_BELOW_PX);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < OVERLAY_BELOW_PX);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return narrow;
}

/**
 * The active task environment: the Task document plus the Artifacts panel
 * beside it (a right split; an overlay only under a narrow window). No header,
 * no strip, no second presentation mode.
 */
export function AgentShell({
  taskContent,
  taskId,
}: {
  taskContent: ReactNode;
  taskId: string | null;
}) {
  const [state, dispatch] = useReducer(agentShellReducer, taskId, (id) => initialAgentShellState(id, readOpenPreference()));
  const narrow = useNarrowWindow();
  const run = useSessionRun(taskId ?? "");
  const [reloadKey, setReloadKey] = useState(0);
  const open = state.artifactsOpen && Boolean(taskId);
  const projection = useAgentTaskProjection(taskId, open, state.selection, reloadKey);
  const provenance = useTaskProvenance(taskId, Boolean(taskId));

  useEffect(() => {
    dispatch({ type: "task.changed", taskId });
  }, [taskId]);

  // The panel lists durable outputs: re-read them when the task's execution settles.
  useEffect(() => {
    if (!run.busy) setReloadKey((key) => key + 1);
  }, [run.busy]);

  useEffect(() => {
    try {
      localStorage.setItem(ARTIFACTS_KEY, state.artifactsOpen ? "1" : "0");
    } catch {
      /* private mode */
    }
  }, [state.artifactsOpen]);

  useEffect(() => publishAgentCommands((command) => dispatch(command)), []);

  return (
    <div
      data-testid="agent-shell"
      data-artifacts={open ? "open" : "closed"}
      data-artifacts-kind={open ? state.selection?.kind ?? "evidence" : undefined}
      className="native-task-area"
    >
      <section className="agent-task-content" data-testid="agent-task-content" data-empty={taskId ? "false" : "true"}>
        {taskContent}
      </section>
      {open ? (
        <ArtifactsPanel
          selection={state.selection}
          projection={projection}
          provenance={provenance}
          overlay={narrow}
          onOpen={(kind, id) => dispatch({ type: "artifacts.open", kind, id: id ?? null })}
          onBack={() => dispatch({ type: "artifacts.back" })}
          onClose={() => dispatch({ type: "artifacts.close" })}
        />
      ) : null}
    </div>
  );
}
