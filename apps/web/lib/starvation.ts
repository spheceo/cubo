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

/** A swarm can download fast overall and still never deliver the pieces
 *  at the playhead (Devil's Hour, 2026-10-21: 0.6 MiB/s against 0.97
 *  needed, but the one segment waited 55 s until Core gave up). After
 *  this long on one stall with Core holding under a second ahead, the
 *  source moves on whatever its throughput says. */
export const STARVED_HARD_SWITCH_MS = 40_000;
const STUCK_READY_AHEAD_SECONDS = 1;

/** Whether the open stall has outlasted any throughput excuse: long, and
 *  Core has nothing ready past the playhead either. */
export function stuckAtPlayhead(stalls: Stall[], now: number, readyAheadSeconds: number | undefined): boolean {
  const open = stalls.find((stall) => stall.end == null);
  if (!open || now - open.start < STARVED_HARD_SWITCH_MS) return false;
  return readyAheadSeconds == null || readyAheadSeconds < STUCK_READY_AHEAD_SECONDS;
}

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
