import type { ToolActivity } from "../types";
import { WorkedGroup } from "./WorkedGroup";

export { argLabel, argSummary, fmtCallMs, isFailed } from "./WorkedGroup";

/** The Agent is working but has not emitted the first item yet. */
export function WorkingRow({ label }: { label: string }) {
  return (
    <div className="flex min-h-6 items-center gap-2 text-xs" data-testid="working-row">
      <span className="working-mark" data-testid="trace-running" aria-hidden />
      <span className="working-shimmer min-w-0 truncate" data-contrast-exempt>{label}</span>
    </div>
  );
}

/**
 * Real tool work grouped under one "Worked for …" line: the same WorkedGroup
 * the transcript renders, kept as a bare-rows entry for the unit contracts.
 */
export function LiveTrace({ items, sessionId, streaming = false }: { items: ToolActivity[]; sessionId?: string | null; streaming?: boolean }) {
  return <WorkedGroup records={items} sessionId={sessionId} live={streaming} />;
}
