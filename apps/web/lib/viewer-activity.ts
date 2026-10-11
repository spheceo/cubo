/** With nobody touching the page this long, the viewer has fallen asleep
 *  or walked off: playback stops at the credits instead of rolling on into
 *  the next episode unseen (which also marks the episode watched for them). */
export const STILL_WATCHING_MS = 2 * 60 * 60 * 1000;

const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;

/** Module-level, so a player remounting after a reconnect does not count
 *  as the viewer coming back. Loading the player is activity. */
let lastActivityAt = performance.now();
let listening = false;

export function markViewerActive(now = performance.now()): void {
  lastActivityAt = now;
}

/** Starts tracking the viewer's input on this page (once). */
export function watchViewerActivity(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  const mark = () => markViewerActive();
  for (const type of ACTIVITY_EVENTS) {
    window.addEventListener(type, mark, { capture: true, passive: true });
  }
}

export function viewerStillWatching(now = performance.now()): boolean {
  return now - lastActivityAt < STILL_WATCHING_MS;
}
