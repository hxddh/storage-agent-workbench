import { useEffect, useRef, type ComponentProps } from "react";
import { isEditable, matches } from "../shortcuts";
import { nextTurnIndex, stepTurnIndex, type TurnDirection } from "../lib/threadNavigation";
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
  const navigationIndexRef = useRef<number | null>(null);

  // A session switch is a new document. Pointer/wheel/touch interaction hands
  // navigation back to the reader; the next j/k press then infers a fresh
  // semantic cursor from the viewport. Programmatic smooth-scroll events do not
  // reset it, which is exactly what makes k -> j reversible.
  useEffect(() => {
    navigationIndexRef.current = null;
  }, [props.sessionId]);

  useEffect(() => {
    const resetNavigation = () => {
      navigationIndexRef.current = null;
    };
    const workspace = workspaceRef.current;
    workspace?.addEventListener("wheel", resetNavigation, { passive: true });
    workspace?.addEventListener("touchstart", resetNavigation, { passive: true });
    workspace?.addEventListener("pointerdown", resetNavigation, { passive: true });
    return () => {
      workspace?.removeEventListener("wheel", resetNavigation);
      workspace?.removeEventListener("touchstart", resetNavigation);
      workspace?.removeEventListener("pointerdown", resetNavigation);
    };
  }, []);

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

      let target: number | null;
      if (navigationIndexRef.current === null) {
        const rootRect = scrollRoot.getBoundingClientRect();
        const positions = turns.map(
          (turn) => turn.getBoundingClientRect().top - rootRect.top + scrollRoot.scrollTop,
        );
        target = nextTurnIndex(positions, scrollRoot.scrollTop, direction);
      } else {
        target = stepTurnIndex(navigationIndexRef.current, turns.length, direction);
      }
      if (target === null) return;
      navigationIndexRef.current = target;

      // Own these bare-letter shortcuts at the workspace boundary. The legacy
      // implementation still carries its historical listener internally; this
      // capture listener prevents a second scroll decision from racing it while
      // that implementation is decomposed behind the public surface.
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
