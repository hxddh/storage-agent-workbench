import type { ComponentProps } from "react";
import { Thread as ThreadImplementation } from "./ThreadImplementation";

/**
 * Public boundary of the conversation workspace.
 *
 * The historical Thread implementation grew to ~76 KB because transport state,
 * session recovery, streaming, scroll anchoring, message rendering, start-state
 * composition, inspector orchestration and composer wiring all accumulated in
 * one public component. That made every UI change a change to the application's
 * largest state machine.
 *
 * v0.91 puts a hard boundary in front of it. The tested runtime implementation
 * is intentionally preserved byte-for-byte in ThreadImplementation while the
 * public Thread now owns only the workspace boundary. Subsequent extractions can
 * move one responsibility at a time behind this boundary without changing App,
 * tests or the rest of the product on every step.
 */
export type ThreadProps = ComponentProps<typeof ThreadImplementation>;

export function Thread(props: ThreadProps) {
  return (
    <section
      data-testid="agent-workspace"
      aria-label="Agent workspace"
      className="relative flex h-full min-w-0 flex-1 overflow-hidden bg-canvas"
    >
      <ThreadImplementation {...props} />
    </section>
  );
}
