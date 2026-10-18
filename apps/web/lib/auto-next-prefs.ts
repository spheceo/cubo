/**
 * Viewer preference for rolling on into the next episode when the credits
 * prompt's countdown runs out. Persisted locally like the intro auto-skip.
 * Off keeps the Next episode button, without the countdown.
 */

const STORAGE_KEY = 'cubo.auto-play-next.v1';

export function loadAutoPlayNextPref(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null');
    return parsed !== false;
  } catch {
    return true;
  }
}

export function saveAutoPlayNextPref(enabled: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(enabled));
  } catch {
    // Private-mode quota errors are fine to ignore; the pref just won't stick.
  }
}
