import { useCallback, useEffect, useState } from 'react';
import {
  IoLink,
  IoRefresh,
  IoServer,
  IoSpeedometer,
  IoTrash,
} from 'react-icons/io5';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Dropdown } from '@/components/dropdown';
import { FolderPicker } from '@/components/folder-picker';
import { Link } from '@/components/link';
import {
  clearCache,
  connectCoreEndpoint,
  currentOriginCoreEndpoint,
  deleteCacheItem,
  discoverLocalEngine,
  getCacheStatus,
  getSystemStats,
  normalizeCoreEndpoint,
  pairWithCore,
  PairingRequiredError,
  updateCacheDirectory,
  updateCacheLimit,
  type CacheStatus,
  type LocalEngineConnection,
  type SystemStats,
} from '@/lib/local-engine';

const GIGABYTE = 1024 ** 3;
const CACHE_OPTIONS = [10, 25, 50, 100, 250];

type CoreTab = 'connection' | 'storage' | 'system';

const CORE_TABS: { id: CoreTab; label: string }[] = [
  { id: 'connection', label: 'Connection' },
  { id: 'storage', label: 'Content cache' },
  { id: 'system', label: 'System' },
];

export function CoreSettings({
  endpoint,
  connection,
  currentOriginCore = false,
  embeddedCore = false,
  initialPairingEndpoint = '',
  onSave,
  onClose,
}: {
  endpoint: string;
  connection: LocalEngineConnection | null;
  currentOriginCore?: boolean;
  embeddedCore?: boolean;
  /** Set when startup discovery found a Core that wants a pairing code. */
  initialPairingEndpoint?: string;
  onSave: (endpoint: string, connection: LocalEngineConnection | null) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(endpoint);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<CoreTab>('connection');
  const [searching, setSearching] = useState(false);
  const [pairingEndpoint, setPairingEndpoint] = useState(initialPairingEndpoint);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  async function saveRemoteCore() {
    setTesting(true);
    setError(null);
    try {
      const normalized = normalizeCoreEndpoint(draft);
      const nextConnection = await connectCoreEndpoint(normalized);
      onSave(normalized, nextConnection);
    } catch (reason) {
      if (reason instanceof PairingRequiredError) {
        setPairingEndpoint(reason.endpoint);
      } else {
        setError(reason instanceof Error ? reason.message : 'Could not connect to Cubo Core');
      }
    } finally {
      setTesting(false);
    }
  }

  async function searchForCore() {
    // Re-runs startup discovery on this device; an empty endpoint means
    // "auto", so a found Core is saved without pinning an address.
    setSearching(true);
    setError(null);
    try {
      const found = await discoverLocalEngine('');
      onSave('', found);
    } catch (reason) {
      if (reason instanceof PairingRequiredError) {
        setPairingEndpoint(reason.endpoint);
      } else {
        setError(
          reason instanceof Error
            ? reason.message
            : 'Could not find Cubo Core on this device',
        );
      }
    } finally {
      setSearching(false);
    }
  }

  /** Where a successful pairing is saved: the page's own Core stays on
   *  automatic discovery, an explicit remote address is pinned. */
  function endpointToSave(paired: string): string {
    return paired === currentOriginCoreEndpoint() ? '' : paired;
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center bg-black/75 p-3 backdrop-blur-md sm:items-center sm:p-6"
      onClick={onClose}
      role="presentation"
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="core-settings-title"
        className="max-h-[88dvh] w-full max-w-3xl overflow-hidden rounded-2xl bg-panel shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="sticky top-0 z-10 bg-panel">
          <div className="flex items-center justify-between px-6 pt-5">
            <h2 id="core-settings-title" className="text-xl font-semibold">
              Core
              {embeddedCore ? ' (built in)' : ''}
            </h2>
            <button
              type="button"
              onClick={onClose}
              className="cursor-pointer rounded-full bg-control px-4 py-2 text-sm text-white transition-colors hover:bg-control-hover"
            >
              Close
            </button>
          </div>

          {/* Browser-style tab strip: the selected tab melts into the panel
              below by overlapping its divider line. */}
          <nav
            aria-label="Core sections"
            className="mt-4 flex items-end gap-1 border-b border-line px-5"
          >
            {CORE_TABS.map((entry) => {
              const active = entry.id === activeTab;
              return (
                <button
                  key={entry.id}
                  role="tab"
                  type="button"
                  aria-selected={active}
                  aria-controls={`core-panel-${entry.id}`}
                  onClick={() => setActiveTab(entry.id)}
                  className={`-mb-px flex cursor-pointer items-center gap-2 rounded-t-xl border-x border-t px-5 py-2.5 text-sm font-semibold transition-colors ${
                    active
                      ? 'border-line bg-panel text-white'
                      : 'border-transparent text-white/45 hover:bg-white/5 hover:text-white'
                  }`}
                >
                  {entry.id === 'connection' ? (
                    <IoLink size={15} />
                  ) : entry.id === 'storage' ? (
                    <IoServer size={15} />
                  ) : (
                    <IoSpeedometer size={15} />
                  )}
                  {entry.label}
                </button>
              );
            })}
          </nav>
        </header>

        <div
          id={`core-panel-${activeTab}`}
          role="tabpanel"
          aria-labelledby={`core-tab-${activeTab}`}
          className="p-6"
        >
          {activeTab === 'connection' ? (
            pairingEndpoint && !connection ? (
              <PairingPrompt
                endpoint={pairingEndpoint}
                onPaired={(paired) => onSave(endpointToSave(pairingEndpoint), paired)}
                onCancel={() => setPairingEndpoint('')}
              />
            ) : (
              <ConnectionPane
                draft={draft}
                testing={testing}
                error={error}
                connection={connection}
                currentOriginCore={currentOriginCore}
                embeddedCore={embeddedCore}
                onDraftChange={setDraft}
                onSaveEndpoint={(next, nextConnection) => onSave(next, nextConnection)}
                onClose={onClose}
                onTest={() => void saveRemoteCore()}
                onErrorClear={() => setError(null)}
                onSearch={() => void searchForCore()}
                searching={searching}
              />
            )
          ) : connection === null ? (
            <p className="py-16 text-center text-sm text-white/45">
              Connect to Cubo Core first.
            </p>
          ) : activeTab === 'storage' ? (
            <StorageSection connection={connection} />
          ) : (
            <SystemSection connection={connection} />
          )}
        </div>
      </section>
    </div>
  );
}

/** Asks for the 6-digit code shown by `cubo pair` on the Core machine.
 *  Pairing works like an authenticator app: the code is derived offline on
 *  the Core, so no account or internet service is involved. */
function PairingPrompt({
  endpoint,
  onPaired,
  onCancel,
}: {
  endpoint: string;
  onPaired: (connection: LocalEngineConnection) => void;
  onCancel: () => void;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pair() {
    setBusy(true);
    setError(null);
    try {
      onPaired(await pairWithCore(endpoint, code));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'That code did not work');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="space-y-6"
      onSubmit={(event) => {
        event.preventDefault();
        void pair();
      }}
    >
      <div>
        <h3 className="font-semibold">Pair this device</h3>
        <p className="mt-2 text-sm leading-6 text-white/60">
          A Cubo Core was found at <span className="text-white/80">{endpoint}</span>, but it
          lives on another machine. On that machine, run{' '}
          <code className="rounded bg-control px-1.5 py-0.5 text-white/80">cubo pair</code> in a
          terminal and enter the 6-digit code it shows. You only do this once per device.
        </p>
      </div>

      <input
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        value={code}
        onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
        onFocus={() => setError(null)}
        placeholder="000000"
        aria-label="Pairing code"
        className="w-full rounded-xl border border-line bg-[#101010] px-4 py-3 text-center text-2xl tracking-[0.5em] text-white outline-none transition-colors placeholder:text-faint focus:border-line-strong"
      />

      {error ? (
        <p role="alert" className="text-sm leading-6 text-white/70">
          {error}
        </p>
      ) : null}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
        <button
          type="button"
          onClick={onCancel}
          className="h-12 cursor-pointer rounded-full bg-control px-6 font-semibold text-white transition-colors hover:bg-control-hover"
        >
          Back
        </button>
        <button
          type="submit"
          disabled={busy || code.length !== 6}
          className="h-12 cursor-pointer rounded-full bg-white px-6 font-semibold text-black transition-colors hover:bg-white/85 disabled:cursor-default disabled:opacity-40"
        >
          {busy ? 'Pairing…' : 'Pair'}
        </button>
      </div>
    </form>
  );
}

function ConnectionPane({
  draft,
  testing,
  error,
  connection,
  currentOriginCore,
  embeddedCore,
  onDraftChange,
  onSaveEndpoint,
  onClose,
  onTest,
  onErrorClear,
  onSearch,
  searching,
}: {
  draft: string;
  testing: boolean;
  error: string | null;
  connection: LocalEngineConnection | null;
  currentOriginCore: boolean;
  embeddedCore: boolean;
  onDraftChange: (value: string) => void;
  onSaveEndpoint: (endpoint: string, connection: LocalEngineConnection | null) => void;
  onClose: () => void;
  onTest: () => void;
  onErrorClear: () => void;
  onSearch: () => void;
  searching: boolean;
}) {
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  // Once connected, the options are noise: show the status card and get out
  // of the way. Only a served-by-this-origin Core cannot be cut loose.
  if (connection) {
    return (
      <div className="space-y-6">
        <p className="text-sm leading-6 text-white/60">
          {currentOriginCore
            ? embeddedCore
              ? 'The desktop app includes Cubo Core, so playback and your library use it automatically.'
              : 'This interface is served by Cubo Core, so playback uses it automatically.'
            : 'Playback and your library run through this Core.'}
        </p>

        <div className="space-y-7 rounded-2xl bg-[#25252570] p-8 backdrop-blur">
          <div className="flex items-center gap-4">
            <span className="size-3 shrink-0 animate-pulse rounded-full bg-accent" />
            <div className="min-w-0">
              <p className="text-lg font-semibold">
                {embeddedCore ? 'Built-in Core ready' : 'Core connected'}
              </p>
              <p className="mt-1.5 truncate text-base text-faint">{connection.baseUrl}</p>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-line pt-5">
            <Link
              href="/library"
              onClick={onClose}
              className="text-sm font-semibold text-muted transition-colors hover:text-white"
            >
              Open your library
            </Link>
            {!currentOriginCore ? (
              <button
                type="button"
                onClick={() => setConfirmingDisconnect(true)}
                aria-label="Disconnect from Cubo Core"
                className="flex cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-sm text-faint transition-colors hover:text-white"
              >
                <IoTrash size={14} />
                Disconnect
              </button>
            ) : null}
          </div>
        </div>

        {confirmingDisconnect ? (
          <ConfirmDialog
            title="Disconnect from Cubo Core?"
            description="Your library stays safe on the Core machine. Cubo will look for a connection again next time it starts."
            confirmLabel="Disconnect"
            onCancel={() => setConfirmingDisconnect(false)}
            onConfirm={() => {
              setConfirmingDisconnect(false);
              onSaveEndpoint('', null);
            }}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Only shown while there is no connection: re-run discovery. */}
      <button
        type="button"
        onClick={onSearch}
        disabled={searching || currentOriginCore}
        className="inline-flex cursor-pointer items-center gap-2 rounded-full bg-control px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-control-hover disabled:cursor-default disabled:opacity-40"
      >
        <IoRefresh size={15} className={searching ? 'animate-spin' : ''} />
        {searching ? 'Searching…' : 'Search for a Core'}
      </button>

      <div>
        <label htmlFor="core-endpoint" className="font-semibold">
          Core address
        </label>
        <p className="mt-2 text-sm leading-6 text-white/60">
          {currentOriginCore
            ? embeddedCore
              ? 'The desktop app includes Cubo Core, so playback and your library use it automatically.'
              : 'This interface is served by Cubo Core, so playback uses it automatically.'
            : 'Leave this empty to find Cubo Core on this device, or enter a Tailscale address.'}
        </p>
        <input
          id="core-endpoint"
          type="url"
          value={draft}
          disabled={currentOriginCore}
          onChange={(event) => onDraftChange(event.target.value)}
          onFocus={onErrorClear}
          placeholder="https://media.your-tailnet.ts.net"
          spellCheck={false}
          autoCapitalize="none"
          className="mt-4 w-full rounded-xl border border-line bg-[#101010] px-4 py-3 text-white outline-none transition-colors placeholder:text-faint focus:border-line-strong"
        />
        {!currentOriginCore ? (
          <p className="mt-2 text-sm leading-6 text-faint">
            Direct addresses such as http://100.64.0.10:8765 are also supported.
          </p>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="text-sm leading-6 text-white/70">
          {error}
        </p>
      ) : null}

      {!currentOriginCore ? (
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          <button
            type="button"
            onClick={() => onSaveEndpoint('', null)}
            className="h-12 cursor-pointer rounded-full bg-control px-6 font-semibold text-white transition-colors hover:bg-control-hover"
          >
            Use this device
          </button>
          <button
            type="button"
            disabled={testing || !draft.trim()}
            onClick={onTest}
            className="h-12 cursor-pointer rounded-full bg-white px-6 font-semibold text-black transition-colors hover:bg-white/85 disabled:cursor-default disabled:opacity-40"
          >
            {testing ? 'Connecting…' : 'Save and connect'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Everything stored on the Core machine: cache budget, folder and contents. */
function StorageSection({ connection }: { connection: LocalEngineConnection }) {
  const [cache, setCache] = useState<CacheStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [confirmingDirectory, setConfirmingDirectory] = useState(false);
  const [pickingDirectory, setPickingDirectory] = useState(false);
  const [directoryDraft, setDirectoryDraft] = useState('');
  const [directoryError, setDirectoryError] = useState<string | null>(null);

  const loadCache = useCallback(async () => {
    try {
      const next = await getCacheStatus(connection);
      setCache(next);
      setDirectoryDraft(next.directory);
    } catch {
      setCache(null);
    } finally {
      setLoaded(true);
    }
  }, [connection]);

  useEffect(() => {
    void loadCache();
  }, [loadCache]);

  async function changeLimit(gigabytes: number) {
    setBusy(true);
    try {
      await updateCacheLimit(connection, gigabytes * GIGABYTE);
      await loadCache();
    } finally {
      setBusy(false);
    }
  }

  async function removeCache(id: string | number) {
    setBusy(true);
    try {
      await deleteCacheItem(connection, id);
      await loadCache();
    } finally {
      setBusy(false);
    }
  }

  async function removeAllCache() {
    setBusy(true);
    try {
      await clearCache(connection);
      await loadCache();
    } finally {
      setBusy(false);
    }
  }

  async function changeDirectory() {
    const next = directoryDraft.trim();
    if (!next || next === cache?.directory) return;
    setBusy(true);
    setDirectoryError(null);
    try {
      await updateCacheDirectory(connection, next);
      await loadCache();
    } catch (caught) {
      setDirectoryError(
        caught instanceof Error ? caught.message : 'Could not change the cache folder',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <p className="leading-7 text-white/60">
        Cubo keeps recently streamed pieces locally. When the limit is reached, the oldest cached
        title is removed first.
      </p>

      <div className="space-y-5 rounded-2xl bg-[#25252570] p-5 backdrop-blur" aria-busy={!loaded}>
        <div className="flex items-end justify-between gap-4">
          <div className="min-w-24">
            <p className="text-sm text-faint">Used</p>
            {loaded ? (
              <p className="mt-1 text-3xl font-semibold">{cache ? formatBytes(cache.usedBytes) : '—'}</p>
            ) : (
              <SkeletonLine className="mt-2 h-8 w-28" />
            )}
          </div>
          <div className="text-right text-sm text-faint">
            Maximum
            <Dropdown
              value={cache ? Math.round(cache.maxBytes / GIGABYTE) : 25}
              options={CACHE_OPTIONS.map((option) => ({
                value: option,
                label: `${option} GB`,
              }))}
              disabled={busy || !cache}
              onChange={(gigabytes) => void changeLimit(gigabytes)}
              ariaLabel="Maximum cache size"
              className="mt-2"
            />
          </div>
        </div>

        <div className="h-1.5 overflow-hidden rounded-full bg-[#4f4f4f]">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-500"
            style={{
              width: `${cache ? Math.min(100, (cache.usedBytes / cache.maxBytes) * 100) : 0}%`,
            }}
          />
        </div>

        <div className="border-t border-line pt-5">
          <p className="text-sm text-faint">Folder on this Core</p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
            {loaded ? (
              <p className="min-w-0 flex-1 truncate rounded-full bg-control px-4 py-2 text-sm text-white/80">
                {cache?.directory ?? '—'}
              </p>
            ) : (
              <SkeletonLine className="h-10 flex-1 rounded-full" />
            )}
            <button
              type="button"
              disabled={busy || loaded !== true || !cache}
              onClick={() => {
                setDirectoryError(null);
                setPickingDirectory(true);
              }}
              className={`inline-flex shrink-0 cursor-pointer items-center justify-center rounded-full bg-white px-4 py-2 text-sm font-semibold text-black transition-colors hover:bg-white/85 ${
                loaded ? '' : 'pointer-events-none opacity-35'
              }`}
            >
              Change folder
            </button>
          </div>
          {directoryError ? (
            <p className="mt-2 text-sm text-white/70">{directoryError}</p>
          ) : (
            <p className="mt-2 text-sm text-faint">
              Pick an empty folder. The current cache is deleted, then new downloads go there.
            </p>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-line pt-5">
          {loaded ? (
            <p className="text-sm text-faint">{cache?.itemCount ?? 0} cached titles</p>
          ) : (
            <SkeletonLine className="h-4 w-24" />
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void loadCache()}
              disabled={busy}
              aria-label="Refresh cache usage"
              className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full text-muted transition-colors hover:bg-control hover:text-white"
            >
              <IoRefresh size={18} />
            </button>
            <button
              type="button"
              onClick={() => setConfirmingClear(true)}
              disabled={busy || !cache?.itemCount}
              className="inline-flex cursor-pointer items-center gap-2 rounded-full bg-control px-4 py-2 text-sm text-white transition-colors hover:bg-control-hover disabled:cursor-default disabled:opacity-35"
            >
              <IoTrash size={15} />
              Clear cache
            </button>
          </div>
        </div>

        {loaded && cache?.entries.length ? (
          <ul className="m-0 max-h-44 list-none divide-y divide-line overflow-y-auto p-0">
            {cache.entries.map((entry) => (
              <li key={entry.infoHash} className="flex items-center justify-between gap-4 py-2.5">
                <p className="min-w-0 truncate text-sm text-white/60">
                  {entry.title || 'Cached video'}
                </p>
                <button
                  type="button"
                  onClick={() => void removeCache(entry.torrentId ?? entry.infoHash)}
                  disabled={busy}
                  className="shrink-0 cursor-pointer text-sm text-faint transition-colors hover:text-white"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {confirmingClear ? (
        <ConfirmDialog
          title="Clear the content cache?"
          description="All locally cached video will be removed. Titles will need to buffer again the next time you watch them."
          confirmLabel="Clear cache"
          onCancel={() => setConfirmingClear(false)}
          onConfirm={() => {
            setConfirmingClear(false);
            void removeAllCache();
          }}
        />
      ) : null}

      {pickingDirectory ? (
        <FolderPicker
          connection={connection}
          currentDirectory={cache?.directory ?? ''}
          onCancel={() => setPickingDirectory(false)}
          onSelect={(path) => {
            setDirectoryDraft(path);
            setPickingDirectory(false);
            setConfirmingDirectory(true);
          }}
        />
      ) : null}

      {confirmingDirectory ? (
        <ConfirmDialog
          title="Change the cache folder?"
          description="Everything currently cached will be deleted, then new downloads will go to the empty folder you picked."
          confirmLabel="Clear and move"
          onCancel={() => setConfirmingDirectory(false)}
          onConfirm={() => {
            setConfirmingDirectory(false);
            void changeDirectory();
          }}
        />
      ) : null}
    </div>
  );
}

/** Live resource stats from the machine running Cubo Core. */
function SystemSection({ connection }: { connection: LocalEngineConnection }) {
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  const loadStats = useCallback(async () => {
    try {
      setStats(await getSystemStats(connection));
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoaded(true);
    }
  }, [connection]);

  useEffect(() => {
    void loadStats();
    // Cheap enough at this cadence, and only runs while the tab is open.
    const timer = window.setInterval(() => void loadStats(), 5000);
    return () => window.clearInterval(timer);
  }, [loadStats]);

  return (
    <div>
      {stats && !failed ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Metric
            label="Storage free"
            value={formatBytes(stats.storage.freeBytes)}
            detail={`of ${formatBytes(stats.storage.totalBytes)} total`}
            ratio={ratioOf(stats.storage.freeBytes, stats.storage.totalBytes)}
          />
          <Metric
            label="Memory used"
            value={formatBytes(stats.memory.usedBytes)}
            detail={`${formatBytes(stats.memory.totalBytes)} installed`}
            ratio={ratioOf(stats.memory.usedBytes, stats.memory.totalBytes)}
          />
          <Metric
            label="CPU"
            value={`${Math.round(stats.cpu.usagePercent)}%`}
            detail={[stats.cpu.brand, `${stats.cpu.coreCount} cores`].filter(Boolean).join(' · ')}
            ratio={stats.cpu.usagePercent / 100}
          />
          {stats.gpu.adapters.length > 0 ? (
            <Metric
              label="GPU"
              value={
                stats.gpu.usagePercent[0] != null
                  ? `${Math.round(stats.gpu.usagePercent[0])}%`
                  : '—'
              }
              detail={stats.gpu.adapters.join(', ')}
              ratio={
                stats.gpu.usagePercent[0] != null ? stats.gpu.usagePercent[0] / 100 : undefined
              }
            />
          ) : null}
          <Metric
            label="Uptime"
            value={formatUptime(stats.uptimeSeconds)}
            detail="Core machine uptime"
          />
        </div>
      ) : loaded && failed ? (
        <p role="alert" className="text-sm leading-6 text-white/70">
          Could not read system stats from this Core. It may be an older version.
        </p>
      ) : (
        // Skeletons while the first read is in flight.
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
          {[0, 1, 2].map((index) => (
            <div key={index} className="rounded-xl bg-[#25252570] p-4">
              <span className="block h-3 w-16 animate-pulse rounded-full bg-white/10" />
              <span className="mt-2 block h-7 w-24 animate-pulse rounded-full bg-white/10" />
              <span className="mt-3 block h-1.5 w-full animate-pulse rounded-full bg-white/10" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A quiet shimmering block standing in for content that is loading. */
function SkeletonLine({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`block animate-pulse rounded-full bg-white/10 ${className ?? ''}`}
    />
  );
}

function Metric({
  label,
  value,
  detail,
  ratio,
}: {
  label: string;
  value: string;
  detail?: string;
  /** 0-1 fill for the usage bar; omitted for stats without a natural ratio. */
  ratio?: number;
}) {
  const clamped = ratio != null ? Math.max(0, Math.min(1, ratio)) : null;
  return (
    <div className="rounded-xl bg-[#25252570] p-4">
      <p className="text-sm text-faint">{label}</p>
      <p className="mt-1.5 text-2xl font-semibold">{value}</p>
      {detail ? <p className="mt-1 truncate text-sm text-white/45">{detail}</p> : null}
      {clamped != null ? (
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[#4f4f4f]">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-500"
            style={{ width: `${clamped * 100}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}

function ratioOf(part: number, total: number): number | undefined {
  return total > 0 ? part / total : undefined;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h`;
  return `${Math.floor(seconds / 60)}m`;
}

function formatBytes(bytes: number): string {
  if (bytes >= GIGABYTE) return `${(bytes / GIGABYTE).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}
