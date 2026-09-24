import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useSearchParams } from 'react-router';
import {
  applyUpdate,
  downloadUpdate,
  getUpdateStatus,
  type CoreUpdateStatus,
} from '@/lib/local-engine';
import { coalesceLatest, fetchGithubLatestTag } from '@/lib/update-check';
import {
  displayTag,
  mergeUpdateStatus,
  updateButtonLabel,
  updateInProgress,
  updateProgressPercent,
} from '@/lib/update-ui';
import { useCore } from './core-provider';

const APPLYING_KEY = 'cubo.updatingTo';

function previewStatus(kind: string | null): CoreUpdateStatus | null {
  if (kind === 'download' || kind === 'updating') {
    return { current: '0.0.9', latest: 'v0.1.0', state: 'downloading', progress: 0.12 };
  }
  if (kind === 'ready') {
    return { current: '0.0.9', latest: 'v0.1.0', state: 'idle' };
  }
  if (kind === 'applying') {
    return { current: '0.0.9', latest: 'v0.1.0', state: 'applying', progress: 1 };
  }
  return null;
}

function versionMatches(running: string, expected: string): boolean {
  return running === expected || `v${running}` === expected || running === expected.replace(/^v/, '');
}

interface UpdateContextValue {
  status: CoreUpdateStatus | null;
  busy: boolean;
  applying: boolean;
  inProgress: boolean;
  start: () => Promise<void>;
}

const UpdateContext = createContext<UpdateContextValue | null>(null);

export function UpdateProvider({ children }: { children: React.ReactNode }) {
  const value = useCoreUpdateState();
  return <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>;
}

export function useCoreUpdate() {
  const value = useContext(UpdateContext);
  if (!value) throw new Error('useCoreUpdate must be used inside <UpdateProvider>');
  return value;
}

function useCoreUpdateState() {
  const { connection } = useCore();
  const [searchParams] = useSearchParams();
  const previewKind = import.meta.env.DEV ? searchParams.get('updatePreview') : null;
  const [status, setStatus] = useState<CoreUpdateStatus | null>(() => previewStatus(previewKind));
  const [busy, setBusy] = useState(false);
  const inFlightRef = useRef(false);
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    const next = previewStatus(previewKind);
    if (next) setStatus(next);
  }, [previewKind]);

  useEffect(() => {
    if (previewKind) return;
    if (!connection) {
      setStatus(null);
      return;
    }

    let cancelled = false;
    const read = async () => {
      try {
        const next = await getUpdateStatus(connection);
        next.latest = coalesceLatest(
          next.latest,
          await fetchGithubLatestTag(),
          connection.version,
        );
        if (!cancelled) {
          setStatus((current) => mergeUpdateStatus(current, next, inFlightRef.current));
        }
      } catch {
        if (!cancelled && !sessionStorage.getItem(APPLYING_KEY) && !inFlightRef.current) {
          setStatus(null);
        }
      }
    };

    void read();
    const applying = status?.state === 'applying' || Boolean(sessionStorage.getItem(APPLYING_KEY));
    const live = applying || status?.state === 'downloading' || busy;
    const timer = window.setInterval(() => void read(), live ? 400 : 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [busy, connection, previewKind, status?.state]);

  useEffect(() => {
    if (previewKind !== 'download' && previewKind !== 'updating') return;
    const seed = previewStatus(previewKind);
    if (!seed) return;
    let progress = seed.progress ?? 0.08;
    const timer = window.setInterval(() => {
      progress = Math.min(0.92, progress + 0.05);
      setStatus({ ...seed, state: 'downloading', progress });
    }, 400);
    return () => window.clearInterval(timer);
  }, [previewKind]);

  useEffect(() => {
    const expected = sessionStorage.getItem(APPLYING_KEY);
    if (!expected || !connection) return;

    let cancelled = false;
    const wait = async () => {
      const deadline = Date.now() + 60_000;
      while (!cancelled && Date.now() < deadline) {
        try {
          const response = await fetch(`${connection.baseUrl}/v1/health`);
          const health = (await response.json()) as { version?: string };
          if (health.version && versionMatches(health.version, expected)) {
            sessionStorage.removeItem(APPLYING_KEY);
            window.location.reload();
            return;
          }
        } catch {
          // Core is down while it relaunches.
        }
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
      }
    };
    void wait();
    return () => {
      cancelled = true;
    };
  }, [connection, status?.state]);

  const start = useCallback(async () => {
    if (!connection || busy || previewKind) return;
    const latest = statusRef.current?.latest;
    if (!latest) return;
    const alreadyReady = statusRef.current?.state === 'ready';
    inFlightRef.current = true;
    setBusy(true);
    setStatus((current) =>
      current
        ? {
            ...current,
            state: alreadyReady ? 'applying' : 'downloading',
            error: null,
            progress: alreadyReady ? 1 : (current.progress ?? 0),
          }
        : current,
    );
    try {
      if (!alreadyReady) {
        const downloaded = await downloadUpdate(connection);
        setStatus(downloaded);
        if (downloaded.state !== 'ready') {
          throw new Error(downloaded.error || 'Could not download the update');
        }
      }
      sessionStorage.setItem(APPLYING_KEY, latest);
      setStatus((current) =>
        current ? { ...current, state: 'applying', progress: 1, error: null } : current,
      );
      setStatus(await applyUpdate(connection));
    } catch (reason) {
      sessionStorage.removeItem(APPLYING_KEY);
      setStatus((current) => ({
        current: current?.current ?? connection.version,
        latest: current?.latest ?? latest,
        state: 'idle',
        progress: 0,
        error: reason instanceof Error ? reason.message : 'Could not install the update',
      }));
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  }, [busy, connection, previewKind]);

  const applying = status?.state === 'applying' || Boolean(sessionStorage.getItem(APPLYING_KEY));
  const inProgress = updateInProgress(status?.state, busy) || applying;
  return useMemo(
    () => ({ status, busy, applying, inProgress, start }),
    [applying, busy, inProgress, start, status],
  );
}

function UpdateActionButton({
  status,
  busy,
  disabled,
  onClick,
}: {
  status: CoreUpdateStatus;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const live = updateInProgress(status.state, busy);
  const percent = updateProgressPercent(status.progress);
  const indeterminate = live && status.state === 'downloading' && percent == null;
  const fill = status.state === 'applying' || (busy && status.state === 'ready') ? 100 : percent;
  const label = updateButtonLabel(status, busy);

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={status.error ?? (status.latest ? `Update to ${displayTag(status.latest)}` : undefined)}
      aria-label={status.latest ? `Update to ${displayTag(status.latest)}` : 'Update'}
      aria-busy={live}
      className="relative isolate h-10 min-w-[11.5rem] shrink-0 cursor-pointer overflow-hidden rounded-full bg-fg px-5 text-sm font-semibold text-ink transition-opacity hover:opacity-90 disabled:cursor-wait"
    >
      {live ? (
        <span
          aria-hidden
          className={`absolute inset-y-0 left-0 bg-black/25 ${
            indeterminate ? 'update-fill-loop' : 'transition-[width] duration-300 ease-out'
          }`}
          style={indeterminate ? undefined : { width: `${fill ?? 0}%` }}
        />
      ) : null}
      <span className="relative">{label}</span>
    </button>
  );
}

export function UpdatePill() {
  const { status, busy, inProgress, start } = useCoreUpdate();
  if (!status?.latest || inProgress) return null;

  return (
    <UpdateActionButton
      status={status}
      busy={busy}
      disabled={busy}
      onClick={() => void start()}
    />
  );
}

export function UpdateOverlay() {
  const { status, busy, applying, inProgress, start } = useCoreUpdate();
  if (!status?.latest || !inProgress) return null;
  const latest = displayTag(status.latest);

  return (
    <div className="pointer-events-none fixed inset-0 z-[100]">
      {applying ? (
        <div
          className="pointer-events-auto absolute inset-0 cursor-wait bg-background/70"
          aria-hidden="true"
        />
      ) : null}
      <div className="pointer-events-auto relative flex items-center justify-center gap-3 border-b border-line bg-panel px-4 py-2.5">
        <p className="m-0 hidden text-sm text-muted sm:block">
          {applying
            ? `Installing ${latest} — Cubo will refresh when it is ready.`
            : `Downloading ${latest} — Cubo will install it when this finishes.`}
        </p>
        <UpdateActionButton
          status={status}
          busy={busy}
          disabled
          onClick={() => void start()}
        />
      </div>
    </div>
  );
}
