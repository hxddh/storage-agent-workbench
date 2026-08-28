import type { ComponentProps } from "react";
import { RunDetail as RunDetailImplementation } from "./RunDetailImplementation";

export type RunDetailProps = ComponentProps<typeof RunDetailImplementation>;

/**
 * Public boundary for an explicit auditable run.
 *
 * A run is not a detail row inside a chat card; once opened it is a review task.
 * The wrapper gives the workspace layer a stable semantic hook while preserving
 * the proven run-loading/streaming implementation behind it.
 */
export function RunDetail(props: RunDetailProps) {
  return (
    <div data-testid="run-workspace-root" className="h-full min-h-0 w-full">
      <RunDetailImplementation {...props} />
    </div>
  );
}
