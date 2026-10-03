/**
 * Viewer preference for skipping detected intros on their own. Persisted
 * locally so the choice follows the viewer across titles and sessions.
 * Auto-skip only ever applies from episode 2 onwards — a show's first
 * episode always plays its intro once.
 */

const STORAGE_KEY = 'cubo.auto-skip-intro.v1';

export function loadAutoSkipIntroPref(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null');
    return parsed !== false;
  } catch {
    return true;
  }
}

export function saveAutoSkipIntroPref(enabled: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(enabled));
  } catch {
    // Private-mode quota errors are fine to ignore; the pref just won't stick.
  }
}

/** Whether an episode is eligible for auto-skip: TV, episode 2 onwards. */
export function introAutoSkipEligible(
  mediaType: string,
  episode: number | null | undefined,
): boolean {
  return mediaType === 'tv' && episode != null && episode >= 2;
}
