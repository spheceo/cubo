import { useEffect } from 'react';
import { useLocation } from 'react-router';

const ORIGIN_KEY = 'cubo.watchOrigin';

/** The player's Back button means "leave playback", not "previous history
 *  entry" — hopping episodes must not turn Back into the previous episode.
 *  This records the last page outside the player so Back lands there. */
export function WatchOriginTracker() {
  const { pathname, search } = useLocation();
  useEffect(() => {
    if (pathname.startsWith('/watch/')) return;
    window.sessionStorage.setItem(ORIGIN_KEY, pathname + search);
  }, [pathname, search]);
  return null;
}

export function watchOrigin(): string | null {
  return window.sessionStorage.getItem(ORIGIN_KEY);
}
