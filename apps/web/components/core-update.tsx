import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useSearchParams } from 'react-router';
import {
  applyUpdate,
  downloadUpdate,
  getUpdateStatus,
  type CoreUpdateStatus,
  type UpdatePhase,
} from '@/lib/local-engine';
import { useCore } from './core-provider';

const APPLYING_KEY = 'cubo.updatingTo';

function previewStatus(kind: string | null): CoreUpdateStatus | null {
  if (kind === 'download') {
    return { current: '0.0.9', latest: 'v0.1.0', state: 'idle' };
  }
  if (kind === 'ready') {
    return { current: '0.0.9', latest: 'v0.1.0', state: 'ready' };
  }
  if (kind === 'applying') {
    return { current: '0.0.9', latest: 'v0.1.0', state: 'applying' };
  }
  return null;
}

function displayTag(tag: string): string {
  return tag.startsWith('v') ? tag : `v${tag}`;
}

function versionMatches(running: string, expected: string): boolean {
  return running === expected || `v${running}` === expected || running === expected.replace(/^v/, '');
}

interface UpdateContextValue {
  status: CoreUpdateStatus | null;
  busy: boolean;
  applying: boolean;
  download: () => Promise<void>;
  apply: () => Promise<void>;
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
  const preview = import.meta.env.DEV ? previewStatus(searchParams.get('updatePreview')) : null;
  const [status, setStatus] = useState<CoreUpdateStatus | null>(preview);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (preview) {
      setStatus(preview);
      return;
    }
    if (!connection) {
      setStatus(null);
      return;
    }

    let cancelled = false;
    const read = async () => {
      try {
        const next = await getUpdateStatus(connection);
        if (!cancelled) setStatus(next);
      } catch {
        if (!cancelled && !sessionStorage.getItem(APPLYING_KEY)) setStatus(null);
      }
    };

    void read();
    const applying = status?.state === 'applying' || Boolean(sessionStorage.getItem(APPLYING_KEY));
    const timer = window.setInterval(() => void read(), applying || status?.state === 'downloading' ? 1_000 : 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [connection, preview, status?.state]);

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

  const download = useCallback(async () => {
    if (!connection || busy) return;
    setBusy(true);
    setStatus((current) =>
      current ? { ...current, state: 'downloading' as UpdatePhase, error: null } : current,
    );
    try {
      setStatus(await downloadUpdate(connection));
    } catch (reason) {
      setStatus((current) => ({
        current: current?.current ?? connection.version,
        latest: current?.latest ?? null,
        state: 'idle',
        error: reason instanceof Error ? reason.message : 'Could not download the update',
      }));
    } finally {
      setBusy(false);
    }
  }, [busy, connection]);

  const apply = useCallback(async () => {
    if (!connection || busy) return;
    const latest = status?.latest;
    if (!latest) return;
    setBusy(true);
    sessionStorage.setItem(APPLYING_KEY, latest);
    setStatus((current) =>
      current ? { ...current, state: 'applying' as UpdatePhase, error: null } : current,
    );
    try {
      setStatus(await applyUpdate(connection));
    } catch (reason) {
      sessionStorage.removeItem(APPLYING_KEY);
      setStatus((current) => ({
        current: current?.current ?? connection.version,
        latest: current?.latest ?? latest,
        state: 'ready',
        error: reason instanceof Error ? reason.message : 'Could not install the update',
      }));
    } finally {
      setBusy(false);
    }
  }, [busy, connection, status?.latest]);

  const applying = status?.state === 'applying' || Boolean(sessionStorage.getItem(APPLYING_KEY));
  return useMemo(
    () => ({ status, busy, applying, download, apply }),
    [apply, applying, busy, download, status],
  );
}

export function UpdatePill() {
  const { status, busy, applying, download, apply } = useCoreUpdate();
  if (!status?.latest || applying) return null;

  const label =
    status.state === 'ready' || status.state === 'downloading'
      ? status.state === 'downloading'
        ? `Downloading ${displayTag(status.latest)}`
        : `Update to ${displayTag(status.latest)}`
      : `Download ${displayTag(status.latest)}`;

  return (
    <button
      type="button"
      disabled={busy || status.state === 'downloading'}
      onClick={() => {
        if (status.state === 'ready') void apply();
        else void download();
      }}
      title={status.error ?? undefined}
      className="h-10 shrink-0 cursor-pointer rounded-full bg-fg px-5 text-sm font-semibold text-ink transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-70"
    >
      {label}
    </button>
  );
}

export function UpdateOverlay() {
  const { status, applying } = useCoreUpdate();
  if (!applying) return null;
  const latest = status?.latest ? displayTag(status.latest) : 'the new version';

  return (
    <div className="fixed inset-0 z-[100]">
      <div className="bg-fg px-6 py-3 text-center text-sm font-semibold text-ink">
        Update in progress — Cubo will refresh when {latest} is ready. You can&rsquo;t watch or change
        settings until then.
      </div>
      <div className="absolute inset-0 top-11 cursor-wait bg-background/70" aria-hidden="true" />
    </div>
  );
}
