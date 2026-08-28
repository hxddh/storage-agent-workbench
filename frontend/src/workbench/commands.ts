import type { WorkSurface } from "./model";

export type WorkbenchCommand =
  | { type: "surface.open"; surface: WorkSurface }
  | { type: "run.open"; runId: string };

type CommandHandler = (command: WorkbenchCommand) => void;
let handler: CommandHandler | null = null;

/** Publish the currently mounted Workbench command target. */
export function publishWorkbenchCommands(next: CommandHandler): () => void {
  handler = next;
  return () => {
    if (handler === next) handler = null;
  };
}

/**
 * Route a semantic action to the application work surface.
 *
 * This exists for migration seams such as Timeline proposals and answer links:
 * they ask to open Evidence/Report/Run, but never know whether that surface is a
 * tab, a full-window document or something else. No DOM events or modal state.
 */
export function openWorkbenchSurface(surface: WorkSurface): void {
  handler?.({ type: "surface.open", surface });
}

export function openWorkbenchRun(runId: string): void {
  handler?.({ type: "run.open", runId });
}
