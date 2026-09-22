import { useState } from 'react';
import { IoClose } from 'react-icons/io5';
import { useLocation } from 'react-router';
import { useCacheStatus } from '@/lib/use-cache-status';
import { useCore } from './core-provider';

const DISMISS_KEY = 'cubo.storageBannerDismissed';

/** Disk pressure is separate from Cubo's own cache budget. */
export function StorageWarningBanner() {
  const { connection, openSettings } = useCore();
  const { pathname } = useLocation();
  const { data: cache, isError } = useCacheStatus(connection);
  const [dismissed, setDismissed] = useState(
    () => window.sessionStorage.getItem(DISMISS_KEY) === '1',
  );
  // Routine cleanup must not cover the player's controls. If the disk is
  // critically full, playback already reports Core's actionable error.
  if (
    pathname.startsWith('/watch/') ||
    !connection ||
    isError ||
    !cache?.diskPressure ||
    dismissed
  )
    return null;

  return (
    <div
      role="alert"
      className="fixed inset-x-0 top-0 z-[60] flex items-center justify-center gap-3 border-b border-line bg-panel px-4 py-2.5 text-sm text-white"
    >
      <p className="m-0 min-w-0 truncate text-center">
        This computer is running low on storage. Cubo is clearing older videos.
      </p>
      <button
        type="button"
        onClick={openSettings}
        className="shrink-0 cursor-pointer rounded-full bg-white px-3 py-1 text-sm font-semibold text-black transition-colors hover:bg-white/85"
      >
        Cache
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => {
          window.sessionStorage.setItem(DISMISS_KEY, '1');
          setDismissed(true);
        }}
        className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-faint transition-colors hover:bg-control hover:text-white"
      >
        <IoClose size={18} />
      </button>
    </div>
  );
}
