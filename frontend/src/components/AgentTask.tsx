import { useEffect, useRef, type ComponentProps } from "react";
import { isEditable, matches } from "../shortcuts";
import {
  nextTaskStepIndex,
  RELEASE_TASK_FOLLOW_EVENT,
  stepTaskIndex,
  taskStepScrollTop,
  type TaskStepDirection,
} from "../lib/taskNavigation";
import { AgentTaskImplementation } from "./AgentTaskImplementation";

/**
 * Public boundary of one active Agent task.
 *
 * Persistence still stores task records in the historical session schema, but
 * that implementation detail stops here. Product callers speak only in Tasks;
 * the adapter below is the single translation into the proven persistence and
 * streaming lifecycle.
 */
type PersistenceProps = ComponentProps<typeof AgentTaskImplementation>;
export type AgentTaskProps = Omit<
  PersistenceProps,
  "sessionId" | "onSessionCreated" | "onSessionDiscarded"
> & {
  taskId: string | null;
  onTaskCreated: (id: string) => void;
  onTaskDiscarded: (id: string) => void;
};

export function AgentTask({ taskId, onTaskCreated, onTaskDiscarded, ...props }: AgentTaskProps) {
  const workspaceRef = useRef<HTMLElement | null>(null);
  const navigationIndexRef = useRef<number | null>(null);

  useEffect(() => {
    navigationIndexRef.current = null;
  }, [taskId]);

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

      const scrollRoot = workspaceRef.current?.querySelector<HTMLElement>("[data-testid='task-scroll']");
      if (!scrollRoot) return;
      const directions = Array.from(scrollRoot.querySelectorAll<HTMLElement>("[data-direction]"));
      if (directions.length === 0) return;

      let target: number | null;
      if (navigationIndexRef.current === null) {
        const rootRect = scrollRoot.getBoundingClientRect();
        const positions = directions.map(
          (item) => item.getBoundingClientRect().top - rootRect.top + scrollRoot.scrollTop,
        );
        target = nextTaskStepIndex(positions, scrollRoot.scrollTop, direction);
      } else {
        target = stepTaskIndex(navigationIndexRef.current, directions.length, direction);
      }
      if (target === null) return;
      navigationIndexRef.current = target;

      event.preventDefault();
      // Follow-latest converges by writing scrollTop every frame. A smooth
      // in-view alignment is also a no-op in Chromium when the target
      // Direction is already on screen. Instant scrollTop is the reading
      // move j/k own.
      scrollRoot.dispatchEvent(new Event(RELEASE_TASK_FOLLOW_EVENT, { bubbles: true }));
      const step = directions[target];
      if (!step) return;
      const offset =
        step.getBoundingClientRect().top - scrollRoot.getBoundingClientRect().top + scrollRoot.scrollTop;
      scrollRoot.scrollTo({ top: taskStepScrollTop(offset), behavior: "auto" });
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
      <AgentTaskImplementation
        {...props}
        sessionId={taskId}
        onSessionCreated={onTaskCreated}
        onSessionDiscarded={onTaskDiscarded}
      />
    </section>
  );
}
