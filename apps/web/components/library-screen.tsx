import type { MediaSummary, WatchLaterItem } from '@cubo/core';
import { MediaCard } from '@cubo/ui';
import { useCallback, useEffect, useState } from 'react';
import { IoRefresh, IoServer, IoTrash } from 'react-icons/io5';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { ContinueWatching } from '@/components/continue-watching';
import { Dropdown } from '@/components/dropdown';
import { Link } from '@/components/link';
import {
  clearCache,
  deleteCacheItem,
  getCacheStatus,
  updateCacheLimit,
  type CacheStatus,
} from '@/lib/local-engine';
import { useCore } from './core-provider';

const GIGABYTE = 1024 ** 3;
const CACHE_OPTIONS = [10, 25, 50, 100, 250];

export function LibraryScreen() {
  const core = useCore();
  const [cache, setCache] = useState<CacheStatus | null>(null);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);

  const loadCache = useCallback(async () => {
    if (!core.connection) return;
    try {
      setCache(await getCacheStatus(core.connection));
    } catch {
      setCache(null);
    }
  }, [core.connection]);

  useEffect(() => {
    void core.refreshLibrary();
  }, [core.refreshLibrary]);

  useEffect(() => {
    void loadCache();
  }, [loadCache]);

  if (core.connection && !core.library) {
    return <main className="min-h-dvh bg-background" aria-busy="true" />;
  }

  if (!core.connection || !core.library) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background px-6 pb-24 pt-32 text-white">
        <div className="max-w-md text-center">
          <p className="text-xl font-semibold text-white/50">LOCAL LIBRARY</p>
          <h1 className="mt-4 text-4xl font-bold">Your viewing stays with you.</h1>
          <p className="mt-4 leading-7 text-white/60">
            Connect to Cubo Core to see viewing progress, saved titles and local cache usage.
          </p>
          <button
            type="button"
            onClick={core.openSettings}
            className="mt-8 inline-flex h-12 w-48 cursor-pointer items-center justify-center rounded-full bg-white font-semibold text-black"
          >
            Connect Core
          </button>
        </div>
      </main>
    );
  }

  const { history, watchLater, analytics } = core.library;

  async function changeLimit(gigabytes: number) {
    if (!core.connection) return;
    setCacheBusy(true);
    try {
      await updateCacheLimit(core.connection, gigabytes * GIGABYTE);
      await loadCache();
    } finally {
      setCacheBusy(false);
    }
  }

  async function removeCache(id: string | number) {
    if (!core.connection) return;
    setCacheBusy(true);
    try {
      await deleteCacheItem(core.connection, id);
      await loadCache();
    } finally {
      setCacheBusy(false);
    }
  }

  async function removeAllCache() {
    if (!core.connection) return;
    setCacheBusy(true);
    try {
      await clearCache(core.connection);
      await loadCache();
    } finally {
      setCacheBusy(false);
    }
  }

  return (
    <main className="min-h-dvh space-y-16 bg-background px-6 pb-24 pt-28 text-white sm:px-10">
      <header>
        <p className="text-xl font-semibold text-white/50">LOCAL TO CUBO CORE</p>
        <h1 className="mt-3 text-5xl font-bold sm:text-6xl">Library</h1>
        <p className="mt-4 max-w-xl leading-7 text-white/60">
          Progress, history and saved titles live on the machine running Cubo Core.
        </p>
      </header>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Time watched" value={formatWatchTime(analytics.totalWatchSeconds)} />
        <Metric label="Play sessions" value={String(analytics.playSessions)} />
        <Metric label="Titles started" value={String(analytics.titlesStarted)} />
        <Metric label="Completed" value={String(analytics.titlesCompleted)} />
      </section>

      <ContinueWatching className="" />
      <SavedGrid title="Watch Later" items={watchLater} />
      <HistoryGrid items={history.slice(0, 16)} />

      <section className="space-y-5 border-t border-line pt-12">
        <div className="flex items-center gap-3">
          <IoServer size={22} />
          <h2 className="text-2xl font-semibold">Content cache</h2>
        </div>
        <p className="max-w-xl leading-7 text-white/60">
          Cubo keeps recently streamed pieces locally. When the limit is reached, the oldest cached
          title is removed first.
        </p>

        <div className="max-w-xl rounded-2xl bg-panel p-6">
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="text-sm text-faint">Used</p>
              <p className="mt-1 text-3xl font-semibold">
                {cache ? formatBytes(cache.usedBytes) : '—'}
              </p>
            </div>
            <div className="text-right text-sm text-faint">
              Maximum
              <Dropdown
                value={cache ? Math.round(cache.maxBytes / GIGABYTE) : 50}
                options={CACHE_OPTIONS.map((option) => ({
                  value: option,
                  label: `${option} GB`,
                }))}
                disabled={cacheBusy || !cache}
                onChange={(gigabytes) => void changeLimit(gigabytes)}
                ariaLabel="Maximum cache size"
                className="mt-2"
              />
            </div>
          </div>

          <div className="mt-5 h-1.5 overflow-hidden rounded-full bg-[#4f4f4f]">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-500"
              style={{
                width: `${cache ? Math.min(100, (cache.usedBytes / cache.maxBytes) * 100) : 0}%`,
              }}
            />
          </div>

          <div className="mt-5 flex items-center justify-between border-t border-line pt-5">
            <p className="text-sm text-faint">{cache?.itemCount ?? 0} cached titles</p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void loadCache()}
                disabled={cacheBusy}
                aria-label="Refresh cache usage"
                className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full text-muted transition-colors hover:bg-control hover:text-white"
              >
                <IoRefresh size={18} />
              </button>
              <button
                type="button"
                onClick={() => setConfirmingClear(true)}
                disabled={cacheBusy || !cache?.itemCount}
                className="inline-flex cursor-pointer items-center gap-2 rounded-full bg-control px-4 py-2 text-sm text-white transition-colors hover:bg-control-hover disabled:cursor-default disabled:opacity-35"
              >
                <IoTrash size={15} />
                Clear cache
              </button>
            </div>
          </div>

          {cache?.entries.length ? (
            <ul
              className="m-0 mt-4 max-h-52 list-none divide-y divide-line overflow-y-auto p-0"
            >
              {cache.entries.map((entry) => (
                <li key={entry.infoHash} className="flex items-center justify-between gap-4 py-3">
                  <p className="min-w-0 truncate text-sm text-white/60">
                    {entry.title || 'Cached video'}
                  </p>
                  <button
                    type="button"
                    onClick={() => void removeCache(entry.torrentId ?? entry.infoHash)}
                    disabled={cacheBusy}
                    className="shrink-0 cursor-pointer text-sm text-faint transition-colors hover:text-white"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </section>

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
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-panel p-6">
      <p className="text-sm text-faint">{label}</p>
      <p className="mt-2 text-3xl font-semibold">{value}</p>
    </div>
  );
}

function toSummary(item: {
  mediaId: number;
  mediaType: MediaSummary['mediaType'];
  title: string;
  posterPath: string | null;
  backdropPath: string | null;
}): MediaSummary {
  return {
    id: item.mediaId,
    mediaType: item.mediaType,
    title: item.title,
    overview: '',
    posterPath: item.posterPath,
    backdropPath: item.backdropPath,
    releaseDate: '',
    voteAverage: 0,
  };
}

function SavedGrid({ title, items }: { title: string; items: WatchLaterItem[] }) {
  if (items.length === 0) return null;

  return (
    <section>
      <h2 className="text-2xl font-semibold">{title}</h2>
      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
        {items.map((item) => (
          <MediaCard
            key={item.key}
            item={toSummary(item)}
            href={item.detailHref}
            linkComponent={Link}
            className="w-full"
          />
        ))}
      </div>
    </section>
  );
}

function HistoryGrid({
  items,
}: {
  items: {
    key: string;
    mediaId: number;
    mediaType: MediaSummary['mediaType'];
    title: string;
    posterPath: string | null;
    backdropPath: string | null;
    detailHref: string;
    progress: number;
  }[];
}) {
  if (items.length === 0) return null;

  return (
    <section>
      <h2 className="text-2xl font-semibold">Watch History</h2>
      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
        {items.map((item) => (
          <div key={item.key}>
            <MediaCard
              item={toSummary(item)}
              href={item.detailHref}
              linkComponent={Link}
              className="w-full"
            />
            <div className="mx-auto mt-3 h-1 w-[62%] overflow-hidden rounded-full bg-[#4f4f4f]">
              <div
                className="h-full rounded-full bg-accent"
                style={{ width: `${Math.max(2, Math.round(item.progress * 100))}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function formatWatchTime(seconds: number): string {
  const hours = seconds / 3600;
  if (hours < 1) return `${Math.round(seconds / 60)}m`;
  return `${hours.toFixed(hours >= 10 ? 0 : 1)}h`;
}

function formatBytes(bytes: number): string {
  if (bytes >= GIGABYTE) return `${(bytes / GIGABYTE).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}
