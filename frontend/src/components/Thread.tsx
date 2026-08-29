import { useEffect, useRef, type ComponentProps } from "react";
import { isEditable, matches } from "../shortcuts";
import { nextTurnIndex, stepTurnIndex, type TurnDirection } from "../lib/threadNavigation";
import { Thread as ThreadImplementation } from "./ThreadImplementation";

/**
 * Public boundary of the active Agent task.
 *
 * Transport, persisted-task recovery and viewport following live behind focused
 * hooks. This boundary owns document-level interaction that must remain
 * independent of the Agent runtime, including semantic j/k navigation between
 * task steps. There is exactly one keyboard owner: no capture-phase suppression
 * or duplicate listener remains in ThreadImplementation.
 */
export type ThreadProps = ComponentProps<typeof ThreadImplementation>;

export function Thread(props: ThreadProps) {
  const workspaceRef = useRef<HTMLElement | null>(null);
  const navigationIndexRef = useRef<number | null>(null);

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
      if (matches(event, "nextStep")) direction = 1;
      else if (matches(event, "prevStep")) direction = -1;
      if (direction === null) return;

      const scrollRoot = workspaceRef.current?.querySelector<HTMLElement>("[data-testid='thread-scroll']");
      if (!scrollRoot) return;
      const steps = Array.from(scrollRoot.querySelectorAll<HTMLElement>("[data-question]"));
      if (steps.length === 0) return;

      let target: number | null;
      if (navigationIndexRef.current === null) {
        const rootRect = scrollRoot.getBoundingClientRect();
        const positions = steps.map(
          (step) => step.getBoundingClientRect().top - rootRect.top + scrollRoot.scrollTop,
        );
        target = nextTurnIndex(positions, scrollRoot.scrollTop, direction);
      } else {
        target = stepTurnIndex(navigationIndexRef.current, steps.length, direction);
      }
      if (target === null) return;
      navigationIndexRef.current = target;

      event.preventDefault();
      steps[target]?.scrollIntoView({ block: "start", behavior: "smooth" });
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <section
      ref={workspaceRef}
      data-testid="agent-workspace"
      aria-label="Agent task workspace"
      className="relative flex h-full min-w-0 flex-1 overflow-hidden bg-canvas"
    >
      <ThreadImplementation {...props} />
    </section>
  );
}
