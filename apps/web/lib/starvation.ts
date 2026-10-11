/** One spell of the loading overlay; `end` is null while it is still up. */
export interface Stall {
  start: number;
  end: number | null;
}

/** The overlay up this long in one go means the source cannot keep up. */
export const STARVED_SWITCH_MS = 20_000;
/** A trickling source rarely holds the overlay that long: each segment
 *  arrives late, plays, and the overlay comes back (Shark Tank S14E06 from
 *  one peer: 5–15 s stops every 8 s segment). This much overlay within the
 *  window means the same. */
export const STARVED_WINDOW_MS = 90_000;
export const STARVED_WINDOW_STALL_MS = 30_000;

/** Overlay time within the trailing window, the open stall included. */
export function stalledWithin(stalls: Stall[], now: number, windowMs = STARVED_WINDOW_MS): number {
  const from = now - windowMs;
  return stalls.reduce((total, stall) => total + Math.max(0, (stall.end ?? now) - Math.max(stall.start, from)), 0);
}

/** Whether the viewer has waited long enough to call the source starved. */
export function stalledTooLong(stalls: Stall[], now: number): boolean {
  const open = stalls.find((stall) => stall.end == null);
  if (open && now - open.start >= STARVED_SWITCH_MS) return true;
  return stalledWithin(stalls, now) >= STARVED_WINDOW_STALL_MS;
}

/** Drops stalls that ended before the window. */
export function recentStalls(stalls: Stall[], now: number): Stall[] {
  return stalls.filter((stall) => stall.end == null || stall.end > now - STARVED_WINDOW_MS);
}
