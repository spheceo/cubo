export interface Point {
  x: number;
  y: number;
}

/** The most the Next episode countdown slows while the pointer closes in
 *  on its buttons: at full approach it runs at 80% speed. Small enough
 *  that nobody sees the fill slow, enough to buy a reach for Watch
 *  credits a beat more time. */
export const MAX_COUNTDOWN_EASE = 0.2;

/**
 * How purposefully one pointer move heads for a target, 0–1.
 *
 * A viewer hunting for the cursor wiggles it about, so a move counts only
 * for the part of it that closes the distance (sideways or backwards
 * moves are 0), scaled by how near the pointer now is: the reach grows
 * linearly as it nears the buttons, rather than jumping at the first nudge.
 * `span` is the distance at which approach starts to count (the frame's
 * diagonal).
 */
export function approachToward(from: Point, to: Point, target: Point, span: number): number {
  const moved = Math.hypot(to.x - from.x, to.y - from.y);
  if (moved < 1 || span <= 0) return 0;
  const before = Math.hypot(target.x - from.x, target.y - from.y);
  const after = Math.hypot(target.x - to.x, target.y - to.y);
  const heading = (before - after) / moved;
  if (heading <= 0) return 0;
  const closeness = Math.max(0, 1 - after / span);
  return Math.min(1, heading * closeness);
}

/** The countdown's speed, as a share of normal, for an approach of 0–1. */
export function countdownRate(approach: number): number {
  return 1 - MAX_COUNTDOWN_EASE * Math.min(1, Math.max(0, approach));
}
