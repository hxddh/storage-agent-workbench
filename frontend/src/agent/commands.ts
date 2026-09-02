import type { ArtifactKind } from "./model";

/** Commands the Task document, the window menu and the keyboard send to the
 * mounted shell. All of them address the one Artifacts panel. */
export type AgentCommand =
  | { type: "artifacts.open"; kind: ArtifactKind; id?: string | null; findingId?: string | null }
  | { type: "artifacts.toggle" }
  | { type: "artifacts.close" };

type CommandHandler = (command: AgentCommand) => void;
let handler: CommandHandler | null = null;

/** Publish the currently mounted Agent command target. */
export function publishAgentCommands(next: CommandHandler): () => void {
  handler = next;
  return () => {
    if (handler === next) handler = null;
  };
}

/** Point the Artifacts panel at one section, or at one artifact document
 * inside it, without replacing the active Agent task. */
export function openAgentArtifacts(kind: ArtifactKind, id?: string | null, findingId?: string | null): void {
  handler?.({ type: "artifacts.open", kind, id: id ?? null, findingId: findingId ?? null });
}

/** ⌘I / the Task menu: show or hide the panel. */
export function toggleAgentArtifacts(): void {
  handler?.({ type: "artifacts.toggle" });
}

export function closeAgentArtifacts(): void {
  handler?.({ type: "artifacts.close" });
}

/** Legacy surface names the document still uses. Thin aliases over
 * `openAgentArtifacts`; the Review sheet they named no longer exists. */
export type ReviewAlias = "evidence" | "execution" | "report";

export function openAgentReview(review: ReviewAlias, findingId?: string): void {
  openAgentArtifacts(review, null, findingId ?? null);
}

/** Open one durable execution record as a document inside the panel. */
export function openAgentExecution(executionId: string): void {
  openAgentArtifacts("execution", executionId);
}

export function closeAgentReview(): void {
  closeAgentArtifacts();
}
