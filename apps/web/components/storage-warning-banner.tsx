import { useEffect, useState } from 'react';
import { getCacheStatus } from '@/lib/local-engine';
import { useCore } from './core-provider';

const POLL_MS = 5_000;

/** Full-width bar at the top of every screen when Core has paused downloads
 *  to keep 10 GB free on the machine. */
export function StorageWarningBanner() {
  const { connection, openSettings } = useCore();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!connection) {
      setVisible(false);
      return;
    }

    let cancelled = false;
    const read = async () => {
      try {
        const cache = await getCacheStatus(connection);
        if (!cancelled) setVisible(cache.diskPressure === true);
      } catch {
        if (!cancelled) setVisible(false);
      }
    };

    void read();
    const timer = window.setInterval(() => void read(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [connection]);

  if (!visible) return null;

  return (
    <div
      role="alert"
      className="fixed inset-x-0 top-0 z-[60] flex items-center justify-center gap-3 border-b border-line bg-panel px-4 py-2.5 text-sm text-white"
    >
      <p className="m-0 max-w-3xl text-center">
        Cubo paused downloads to keep 10 GB free on this computer. Free some space
        or clear the cache to keep watching.
      </p>
      <button
        type="button"
        onClick={openSettings}
        className="shrink-0 cursor-pointer rounded-full bg-white px-3 py-1 text-sm font-semibold text-black transition-colors hover:bg-white/85"
      >
        Cache
      </button>
    </div>
  );
}
