import type { ComponentProps } from "react";
import { ExecutionDetailImplementation } from "./ExecutionDetailImplementation";

export type ExecutionDetailProps = ComponentProps<typeof ExecutionDetailImplementation>;

/**
 * Review boundary for one explicit auditable execution.
 * `run` remains the backend persistence term; product UI treats it as Execution.
 */
export function ExecutionDetail(props: ExecutionDetailProps) {
  return (
    <div data-testid="execution-detail" className="h-full min-h-0 w-full">
      <ExecutionDetailImplementation {...props} />
    </div>
  );
}
