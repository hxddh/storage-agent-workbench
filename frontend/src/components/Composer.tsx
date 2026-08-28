import type { ComponentProps } from "react";
import { Composer as ComposerImplementation } from "./ComposerImplementation";

export type { Slash } from "./ComposerImplementation";
export type ComposerProps = ComponentProps<typeof ComposerImplementation>;

/**
 * Public prompt surface.
 *
 * The transport/attachment/slash-command implementation stays independently
 * replaceable behind this boundary. The workspace can now change how the prompt
 * is positioned or presented without importing the 18 KB control implementation
 * into every caller or pushing more state back into Thread.
 */
export function Composer(props: ComposerProps) {
  return (
    <div data-testid="prompt-surface" className="min-w-0">
      <ComposerImplementation {...props} />
    </div>
  );
}
