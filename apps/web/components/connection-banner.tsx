import { useState } from 'react';
import { IoClose } from 'react-icons/io5';
import { useLocation } from 'react-router';
import { useCore } from './core-provider';

const DISMISS_KEY = 'cubo.coreBannerDismissed';

/** Floating pill at the bottom of the screen, shown only after a startup
 *  connection attempt has actually failed. The player has its own error
 *  surface, so the banner stays off the watch route. */
export function ConnectionBanner() {
  const { connection, connectionChecked, openSettings } = useCore();
  const { pathname } = useLocation();
  const [dismissed, setDismissed] = useState(
    () => window.sessionStorage.getItem(DISMISS_KEY) === '1',
  );

  const hidden =
    !connectionChecked || connection !== null || dismissed || pathname.startsWith('/watch/');
  if (hidden) return null;

  return (
    <div className="fixed inset-x-0 bottom-5 z-40 flex justify-center px-4">
      <div className="flex items-center gap-3 rounded-full border border-line bg-panel py-2 pl-5 pr-2 shadow-[0_16px_48px_rgba(0,0,0,0.5)]">
        <span className="size-1.5 shrink-0 rounded-full bg-faint" />
        <p className="m-0 text-sm text-muted">Cubo Core isn&rsquo;t connected</p>
        <button
          type="button"
          onClick={openSettings}
          className="cursor-pointer rounded-full bg-white px-4 py-1.5 text-sm font-semibold text-black transition-colors hover:bg-white/85"
        >
          Connect
        </button>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => {
            window.sessionStorage.setItem(DISMISS_KEY, '1');
            setDismissed(true);
          }}
          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full text-faint transition-colors hover:bg-control hover:text-white"
        >
          <IoClose size={18} />
        </button>
      </div>
    </div>
  );
}
