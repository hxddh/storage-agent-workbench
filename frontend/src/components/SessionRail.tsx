import type { ComponentProps } from "react";
import {
  SessionRail as SessionRailImplementation,
  MIN_RAIL_WIDTH,
  MAX_RAIL_WIDTH,
  DEFAULT_RAIL_WIDTH,
  clampRailWidth,
  dayBucket,
} from "./SessionRailImplementation";

export {
  MIN_RAIL_WIDTH,
  MAX_RAIL_WIDTH,
  DEFAULT_RAIL_WIDTH,
  clampRailWidth,
  dayBucket,
};
export type { SessionActions } from "./SessionRailImplementation";
export type SessionRailProps = ComponentProps<typeof SessionRailImplementation>;

/**
 * Public navigation boundary. Session discovery/search/menu mechanics are kept
 * behind it so the workspace IA can evolve independently from the rail's data
 * fetching and mutation behavior.
 */
export function SessionRail(props: SessionRailProps) {
  return (
    <div data-testid="navigation-surface" className="contents">
      <SessionRailImplementation {...props} />
    </div>
  );
}
