import { useEffect, useRef, useState } from 'react';
import { IoCheckmarkCircle, IoCloudOfflineOutline, IoSparkles, IoSync } from 'react-icons/io5';
import { useLocation } from 'react-router';
import { isDesktopRuntime } from '@/lib/local-engine';

const CHECK_INTERVAL_MS = 30 * 60 * 1000;
/** Emitted by native chrome: the macOS "Check for Updates…" menu item and the
 *  Windows titlebar button both funnel into the same check flow via this. */
const CHECK_UPDATES_EVENT = 'cubo://check-updates';

type PendingUpdate = import('@tauri-apps/plugin-updater').Update;
/** Manual-check feedback; 'idle' means nothing to show beyond a found update. */
type CheckStatus = 'idle' | 'checking' | 'up-to-date' | 'error';

/** Desktop-only floating pill that appears when a new Cubo release is out.
 *  One click downloads, installs, and relaunches into the new version. The
 *  updater plugin is imported lazily so the web build never carries it. */
export function UpdateBanner() {
  const [update, setUpdate] = useState<PendingUpdate | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [status, setStatus] = useState<CheckStatus>('idle');
  const installingRef = useRef(false);
  const statusTimerRef = useRef<number | null>(null);
  const { pathname } = useLocation();

  function flash(next: Exclude<CheckStatus, 'idle'>, ms = 4000) {
    if (statusTimerRef.current) window.clearTimeout(statusTimerRef.current);
    setStatus(next);
    statusTimerRef.current = window.setTimeout(() => setStatus('idle'), ms);
  }

  async function runCheck(manual: boolean) {
    if (installingRef.current) return;
    if (manual) {
      if (statusTimerRef.current) window.clearTimeout(statusTimerRef.current);
      setStatus('checking');
    }
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const found = await check();
      if (found) {
        setUpdate(found);
        setStatus('idle');
      } else if (manual) {
        flash('up-to-date');
      }
    } catch {
      // Offline or the release feed is unreachable — the next poll retries.
      if (manual) flash('error');
    }
  }

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void runCheck(false);
    const timer = window.setInterval(() => void runCheck(false), CHECK_INTERVAL_MS);

    void (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      if (cancelled) return;
      unlisten = await listen(CHECK_UPDATES_EVENT, () => void runCheck(true));
    })();

    return () => {
      cancelled = true;
      unlisten?.();
      window.clearInterval(timer);
    };
  }, []);

  useEffect(
    () => () => {
      if (statusTimerRef.current) window.clearTimeout(statusTimerRef.current);
    },
    [],
  );

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

  const manualStatus = status !== 'idle';

  // Never interrupt playback with the passive pill; an explicit manual check
  // reports everywhere.
  if (!update && !manualStatus) return null;
  if (!manualStatus && pathname.startsWith('/watch/')) return null;

  const installing = progress !== null;

  return (
    <div className="fixed inset-x-0 bottom-5 z-40 flex justify-center px-4">
      {!update ? (
        <div className="flex items-center gap-3 rounded-full border border-line bg-panel py-2 pl-5 pr-5 shadow-[0_16px_48px_rgba(0,0,0,0.5)]">
          {status === 'checking' ? (
            <>
              <IoSync size={15} className="shrink-0 animate-spin text-accent" />
              <p className="m-0 text-sm text-muted">Checking for updates…</p>
            </>
          ) : status === 'up-to-date' ? (
            <>
              <IoCheckmarkCircle size={15} className="shrink-0 text-accent" />
              <p className="m-0 text-sm text-muted">Cubo is up to date</p>
            </>
          ) : (
            <>
              <IoCloudOfflineOutline size={15} className="shrink-0 text-muted" />
              <p className="m-0 text-sm text-muted">Couldn’t check for updates — you may be offline</p>
            </>
          )}
        </div>
      ) : (
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
      )}
    </div>
  );
}
