import type { ComponentProps } from "react";
import { RunDetail as RunDetailImplementation } from "./RunDetailImplementation";

export type RunDetailProps = ComponentProps<typeof RunDetailImplementation>;

/**
 * Review boundary for one explicit auditable execution.
 * `run` remains the backend persistence term; product UI treats it as Execution.
 */
export function RunDetail(props: RunDetailProps) {
  return (
    <div data-testid="execution-detail" className="h-full min-h-0 w-full">
      <RunDetailImplementation {...props} />
    </div>
  );
}
