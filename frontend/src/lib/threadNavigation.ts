export type TurnDirection = -1 | 1;

/**
 * Resolve the turn a reader should land on when stepping through a long thread.
 *
 * The old implementation inferred the current turn from a 4px viewport
 * threshold. `scrollIntoView({ block: "start" })` does not guarantee that the
 * target's top is within four pixels of the scroll container's top (padding,
 * browser rounding and layout all matter), so a following `j` could select the
 * same turn again and leave scrollTop unchanged.
 *
 * Use document positions instead. A small reading anchor inside the viewport
 * identifies the turn the reader is currently in; stepping then moves exactly
 * one semantic exchange backward or forward.
 */
export function nextTurnIndex(
  turnPositions: readonly number[],
  scrollTop: number,
  direction: TurnDirection,
  readingAnchorOffset = 64,
): number | null {
  if (turnPositions.length === 0) return null;

  const anchor = scrollTop + readingAnchorOffset;
  let current = 0;
  for (let i = 0; i < turnPositions.length; i += 1) {
    if (turnPositions[i] <= anchor) current = i;
    else break;
  }

  return Math.min(Math.max(current + direction, 0), turnPositions.length - 1);
}
