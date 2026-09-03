import type { ComponentProps } from "react";
import { ExecutionDetailImplementation } from "./ExecutionDetailImplementation";

export type ExecutionDetailProps = ComponentProps<typeof ExecutionDetailImplementation>;

/**
 * Review boundary for one durable Execution (`task_executions` + its
 * `execution_events`). Since v1.12 it reads the same durable log as the
 * transcript — never the `/runs` engine API.
 */
export function ExecutionDetail(props: ExecutionDetailProps) {
  return (
    <div data-testid="execution-detail" className="h-full min-h-0 w-full">
      <ExecutionDetailImplementation {...props} />
    </div>
  );
}
