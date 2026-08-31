import { useEffect, useState, type ReactNode } from "react";
import { publishAgentCommands } from "./commands";
import { AgentReviewPanel } from "./AgentReviewPanel";
import { useAgentCopy } from "./agentCopy";
import type { ReviewSurface } from "./model";
import { useAgentTaskProjection } from "./useAgentTaskProjection";
import { useTaskProvenance } from "../hooks/useTaskProvenance";

export function AgentShell({
  navigation,
  taskContent,
  taskId,
}: {
  navigation: ReactNode;
  taskContent: ReactNode;
  taskId: string | null;
  task?: unknown;
  sidecarStatus?: string;
  onOpenPalette?: () => void;
  onOpenSettings?: () => void;
}) {
  const copy = useAgentCopy();
  const [review, setReview] = useState<ReviewSurface | null>(null);
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(null);
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
  const { detail, report, reportLoading, error } = useAgentTaskProjection(taskId, review);
  const provenance = useTaskProvenance(taskId, Boolean(review) || Boolean(taskId));

  useEffect(() => {
    if (!taskId) {
      setReview(null);
      setSelectedExecutionId(null);
      setSelectedFindingId(null);
    }
  }, [taskId]);

  useEffect(() => publishAgentCommands((command) => {
    if (command.type === "execution.open") {
      setSelectedExecutionId(command.executionId);
      setSelectedFindingId(null);
      setReview("execution");
      return;
    }
    if (command.type === "review.close") {
      setReview(null);
      setSelectedExecutionId(null);
      setSelectedFindingId(null);
      return;
    }
    setSelectedExecutionId(null);
    setSelectedFindingId(command.findingId ?? null);
    setReview(command.review);
  }), []);

  return (
    <div data-testid="agent-shell" data-review={review ?? "closed"} className="agent-native-shell">
      <aside className="agent-native-navigation" aria-label={copy.task.navigation}>{navigation}</aside>

      <section className="agent-native-main">
        <div className="agent-task-workspace">
          <section className="agent-task-content" data-testid="agent-task-content" data-empty={taskId ? "false" : "true"} aria-label={copy.task.workspace}>
            {taskContent}
          </section>
          {review && taskId ? (
            <AgentReviewPanel
              view={review}
              detail={detail}
              report={report}
              reportLoading={reportLoading}
              error={error}
              selectedExecutionId={selectedExecutionId}
              selectedFindingId={selectedFindingId}
              provenance={provenance}
              onOpenExecution={(executionId) => { setSelectedExecutionId(executionId); setSelectedFindingId(null); setReview("execution"); }}
              onCloseExecution={() => setSelectedExecutionId(null)}
              onClose={() => { setReview(null); setSelectedExecutionId(null); setSelectedFindingId(null); }}
            />
          ) : null}
        </div>
      </section>
    </div>
  );
}
