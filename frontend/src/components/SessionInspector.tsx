import type { ComponentProps } from "react";
import {
  SessionInspector as SessionInspectorImplementation,
  inAnchor,
  toolInAnchor,
} from "./SessionInspectorImplementation";

export { inAnchor, toolInAnchor };

/**
 * Public boundary for the deep investigation surface.
 *
 * The implementation is intentionally isolated from callers. v0.91 changes the
 * product model from a 680px utility drawer to a full work surface; keeping the
 * public contract thin lets the implementation be decomposed into summary,
 * findings, memory and timeline panes without forcing Thread to absorb those
 * changes again.
 */
export type SessionInspectorProps = ComponentProps<typeof SessionInspectorImplementation>;

export function SessionInspector(props: SessionInspectorProps) {
  return <SessionInspectorImplementation {...props} />;
}
