import { useEffect, useRef, useState } from 'react';
import { IoSparkles } from 'react-icons/io5';
import { useLocation } from 'react-router';
import { isDesktopRuntime } from '@/lib/local-engine';

const CHECK_INTERVAL_MS = 30 * 60 * 1000;

type PendingUpdate = import('@tauri-apps/plugin-updater').Update;

/** Desktop-only floating pill that appears when a new Cubo release is out.
 *  One click downloads, installs, and relaunches into the new version. The
 *  updater plugin is imported lazily so the web build never carries it. */
export function UpdateBanner() {
  const [update, setUpdate] = useState<PendingUpdate | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const installingRef = useRef(false);
  const { pathname } = useLocation();

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let cancelled = false;

    async function checkForUpdate() {
      if (installingRef.current) return;
      try {
        const { check } = await import('@tauri-apps/plugin-updater');
        const found = await check();
        if (!cancelled && found) setUpdate(found);
      } catch {
        // Offline or the release feed is unreachable — the next poll retries.
      }
    }

    void checkForUpdate();
    const timer = window.setInterval(() => void checkForUpdate(), CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  async function installAndRestart() {
    if (!update || installingRef.current) return;
    installingRef.current = true;
    setFailed(false);
    setProgress(0);
    try {
      let totalBytes = 0;
      let receivedBytes = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          totalBytes = event.data.contentLength ?? 0;
        } else if (event.event === 'Progress') {
          receivedBytes += event.data.chunkLength;
          if (totalBytes > 0) setProgress(Math.min(1, receivedBytes / totalBytes));
        } else if (event.event === 'Finished') {
          setProgress(1);
        }
      });
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    } catch {
      installingRef.current = false;
      setProgress(null);
      setFailed(true);
    }
  }

  // Never interrupt playback; the pill returns on the next screen.
  if (!update || pathname.startsWith('/watch/')) return null;

  const installing = progress !== null;

  return (
    <div className="fixed inset-x-0 bottom-5 z-40 flex justify-center px-4">
      <div className="flex items-center gap-3 rounded-full border border-line bg-panel py-2 pl-5 pr-2 shadow-[0_16px_48px_rgba(0,0,0,0.5)]">
        <IoSparkles size={15} className="shrink-0 text-accent" />
        <p className="m-0 text-sm text-muted">
          {failed
            ? `Update to ${update.version} failed — check your connection`
            : `Cubo ${update.version} is ready`}
        </p>
        <button
          type="button"
          disabled={installing}
          onClick={() => void installAndRestart()}
          className="relative cursor-pointer overflow-hidden rounded-full bg-white px-4 py-1.5 text-sm font-semibold text-black transition-colors hover:bg-white/85 disabled:cursor-default"
        >
          {installing ? (
            <>
              <span
                className="absolute inset-y-0 left-0 bg-black/15 transition-[width] duration-300"
                style={{ width: `${Math.round((progress ?? 0) * 100)}%` }}
              />
              <span className="relative">
                {progress !== null && progress >= 1 ? 'Restarting…' : 'Downloading…'}
              </span>
            </>
          ) : failed ? (
            'Try again'
          ) : (
            'Restart to update'
          )}
        </button>
      </div>
    </div>
  );
}
