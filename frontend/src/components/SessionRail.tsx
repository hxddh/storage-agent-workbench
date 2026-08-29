import type { ComponentProps } from "react";
import { AgentTaskNavigation } from "../workbench/AgentTaskNavigation";
import {
  MIN_RAIL_WIDTH,
  MAX_RAIL_WIDTH,
  DEFAULT_RAIL_WIDTH,
  clampRailWidth,
  dayBucket,
} from "../workbench/navigationModel";

export {
  MIN_RAIL_WIDTH,
  MAX_RAIL_WIDTH,
  DEFAULT_RAIL_WIDTH,
  clampRailWidth,
  dayBucket,
};
export type { SessionActions } from "../workbench/navigationModel";
export type SessionRailProps = ComponentProps<typeof AgentTaskNavigation>;

/** Stable application navigation boundary.
 *
 * v0.93 intentionally changes the product model from investigation history to
 * Agent tasks. The export name stays stable so App owns behavior, not UI jargon.
 */
export function SessionRail(props: SessionRailProps) {
  return (
    <div data-testid="navigation-surface" className="contents">
      <AgentTaskNavigation {...props} />
    </div>
  );
}
