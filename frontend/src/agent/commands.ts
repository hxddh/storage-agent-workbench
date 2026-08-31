import type { ReviewSurface } from "./model";

export type AgentCommand =
  | { type: "review.open"; review: ReviewSurface; findingId?: string }
  | { type: "review.close" }
  | { type: "execution.open"; executionId: string };

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
export function openAgentReview(review: ReviewSurface, findingId?: string): void {
  handler?.({ type: "review.open", review, findingId });
}

export function closeAgentReview(): void {
  handler?.({ type: "review.close" });
}

/** Open one durable execution record inside contextual review. */
export function openAgentExecution(executionId: string): void {
  handler?.({ type: "execution.open", executionId });
}
