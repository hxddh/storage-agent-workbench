import type { ReviewSurface } from "./model";

export type AgentCommand =
  | { type: "review.open"; review: ReviewSurface }
  | { type: "review.close" }
  | { type: "execution.open"; runId: string };

type CommandHandler = (command: AgentCommand) => void;
let handler: CommandHandler | null = null;

/** Publish the currently mounted Agent command target. */
export function publishAgentCommands(next: CommandHandler): () => void {
  handler = next;
  return () => {
    if (handler === next) handler = null;
  };
}

/** Open contextual review without replacing the active Agent task. */
export function openAgentReview(review: ReviewSurface): void {
  handler?.({ type: "review.open", review });
}

export function closeAgentReview(): void {
  handler?.({ type: "review.close" });
}

export function openAgentExecution(runId: string): void {
  handler?.({ type: "execution.open", runId });
}

/**
 * Transitional API for the proven task renderer. This seam is deliberately
 * outside the Agent shell/model: old callers can request their historical
 * destination while the core product only receives review/task commands.
 */
export function openWorkbenchSurface(surface: "timeline" | "evidence" | "runs" | "report"): void {
  if (surface === "timeline") closeAgentReview();
  else openAgentReview(surface);
}

export function openWorkbenchRun(runId: string): void {
  openAgentExecution(runId);
}
