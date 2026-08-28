import { useEffect, useRef, type ComponentProps } from "react";
import { isEditable, matches } from "../shortcuts";
import { nextTurnIndex, type TurnDirection } from "../lib/threadNavigation";
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
 * v0.91 puts a hard boundary in front of it. The proven runtime implementation
 * stays behind ThreadImplementation while workspace-level interaction belongs
 * here. In particular, semantic conversation navigation is a property of the
 * reading workspace and its scroll geometry, not of transport/session state.
 */
export type ThreadProps = ComponentProps<typeof ThreadImplementation>;

export function Thread(props: ThreadProps) {
  const workspaceRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isEditable(event.target)) return;

      let direction: TurnDirection | null = null;
      if (matches(event, "nextTurn")) direction = 1;
      else if (matches(event, "prevTurn")) direction = -1;
      if (direction === null) return;

      const scrollRoot = workspaceRef.current?.querySelector<HTMLElement>("[data-testid='thread-scroll']");
      if (!scrollRoot) return;
      const turns = Array.from(scrollRoot.querySelectorAll<HTMLElement>("[data-question]"));
      if (turns.length === 0) return;

      const rootRect = scrollRoot.getBoundingClientRect();
      const positions = turns.map(
        (turn) => turn.getBoundingClientRect().top - rootRect.top + scrollRoot.scrollTop,
      );
      const target = nextTurnIndex(positions, scrollRoot.scrollTop, direction);
      if (target === null) return;

      // Own these bare-letter shortcuts at the workspace boundary. The legacy
      // implementation still carries its historical listener internally; the
      // capture listener prevents two independent scroll decisions from racing
      // while that implementation is decomposed behind this public surface.
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      turns[target]?.scrollIntoView({ block: "start", behavior: "smooth" });
    };

    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <section
      ref={workspaceRef}
      data-testid="agent-workspace"
      aria-label="Agent workspace"
      className="relative flex h-full min-w-0 flex-1 overflow-hidden bg-canvas"
    >
      <ThreadImplementation {...props} />
    </section>
  );
}
