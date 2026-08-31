export type TaskStepDirection = -1 | 1;

/**
 * CSS `scroll-margin-top` on Direction anchors. Keep in lockstep with
 * `frontend/src/agent-task.css`.
 */
export const TASK_STEP_SCROLL_MARGIN = 72;

/** Ask the task viewport to stop converging on latest before keyboard navigation moves. */
export const RELEASE_TASK_FOLLOW_EVENT = "saw:release-follow";

/** Reading-start scrollTop for a Direction whose offset is measured inside the scroller. */
export function taskStepScrollTop(
  stepOffset: number,
  marginTop = TASK_STEP_SCROLL_MARGIN,
): number {
  return Math.max(0, stepOffset - marginTop);
}

/** Infer the semantic task step currently under the reader's eye. */
export function currentTaskStepIndex(
  stepPositions: readonly number[],
  scrollTop: number,
  readingAnchorOffset = 64,
): number | null {
  if (stepPositions.length === 0) return null;
  const anchor = scrollTop + readingAnchorOffset;
  let current = 0;
  for (let i = 0; i < stepPositions.length; i += 1) {
    if (stepPositions[i] <= anchor) current = i;
    else break;
  }
  return current;
}

/** Move exactly one semantic task step from a known navigation cursor. */
export function stepTaskIndex(
  current: number,
  stepCount: number,
  direction: TaskStepDirection,
): number | null {
  if (stepCount <= 0) return null;
  return Math.min(Math.max(current + direction, 0), stepCount - 1);
}

/** Resolve the first keyboard step when there is no task-navigation cursor yet. */
export function nextTaskStepIndex(
  stepPositions: readonly number[],
  scrollTop: number,
  direction: TaskStepDirection,
  readingAnchorOffset = 64,
): number | null {
  const current = currentTaskStepIndex(stepPositions, scrollTop, readingAnchorOffset);
  return current === null ? null : stepTaskIndex(current, stepPositions.length, direction);
}
