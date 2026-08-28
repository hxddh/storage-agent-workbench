export type TurnDirection = -1 | 1;

/**
 * Infer the semantic turn currently under the reader's eye.
 *
 * Browser scroll positions are not exact turn positions: scroll padding,
 * fractional layout and max-scroll clamping mean a turn aligned with
 * `scrollIntoView({ block: "start" })` can still land dozens of pixels away
 * from its nominal top. A small reading anchor gives us a stable initial turn.
 */
export function currentTurnIndex(
  turnPositions: readonly number[],
  scrollTop: number,
  readingAnchorOffset = 64,
): number | null {
  if (turnPositions.length === 0) return null;

  const anchor = scrollTop + readingAnchorOffset;
  let current = 0;
  for (let i = 0; i < turnPositions.length; i += 1) {
    if (turnPositions[i] <= anchor) current = i;
    else break;
  }
  return current;
}

/** Move exactly one semantic exchange from a known navigation cursor. */
export function stepTurnIndex(
  current: number,
  turnCount: number,
  direction: TurnDirection,
): number | null {
  if (turnCount <= 0) return null;
  return Math.min(Math.max(current + direction, 0), turnCount - 1);
}

/**
 * Resolve the first keyboard step when there is no navigation cursor yet.
 * Subsequent j/k presses should use `stepTurnIndex` from the stored semantic
 * cursor rather than re-inferring from in-flight smooth-scroll geometry.
 */
export function nextTurnIndex(
  turnPositions: readonly number[],
  scrollTop: number,
  direction: TurnDirection,
  readingAnchorOffset = 64,
): number | null {
  const current = currentTurnIndex(turnPositions, scrollTop, readingAnchorOffset);
  return current === null ? null : stepTurnIndex(current, turnPositions.length, direction);
}
