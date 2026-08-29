import type { ComponentProps } from "react";
import { InvestigationNavigation } from "../workbench/InvestigationNavigation";
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
export type SessionRailProps = ComponentProps<typeof InvestigationNavigation>;

/**
 * Compatibility name for the application navigation boundary.
 *
 * The product no longer renders the historical chat/session rail. Keeping this
 * export lets App and mature interaction tests depend on a stable module while
 * the implementation is now the investigation-first Agent OS navigation.
 */
export function SessionRail(props: SessionRailProps) {
  return (
    <div data-testid="navigation-surface" className="contents">
      <InvestigationNavigation {...props} />
    </div>
  );
}
