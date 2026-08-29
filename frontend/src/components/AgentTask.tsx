import { useEffect, useRef, type ComponentProps } from "react";
import { isEditable, matches } from "../shortcuts";
import { nextTaskStepIndex, stepTaskIndex, type TaskStepDirection } from "../lib/taskNavigation";
import { AgentTaskImplementation } from "./AgentTaskImplementation";

/**
 * Public boundary of one active Agent task.
 *
 * This owns document-level task interaction while the implementation owns the
 * proven persistence, streaming and execution lifecycle. Direction navigation
 * is semantic task-step navigation; there is one keyboard owner and one Agent
 * composer for the entire task.
 */
export type AgentTaskProps = ComponentProps<typeof AgentTaskImplementation>;

export function AgentTask(props: AgentTaskProps) {
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

      let direction: TaskStepDirection | null = null;
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
        target = nextTaskStepIndex(positions, scrollRoot.scrollTop, direction);
      } else {
        target = stepTaskIndex(navigationIndexRef.current, steps.length, direction);
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
      <AgentTaskImplementation {...props} />
    </section>
  );
}
