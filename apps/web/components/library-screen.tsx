import { backdropUrl, posterUrl, type LibraryItem, type WatchLaterItem } from '@cubo/core';
import { ArrowClockwise, HardDrives, Trash } from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from '@/components/link';
import { useCore } from './core-provider';
import {
  clearCache,
  deleteCacheItem,
  getCacheStatus,
  updateCacheLimit,
  type CacheStatus,
} from '@/lib/local-engine';

const GIGABYTE = 1024 ** 3;
const CACHE_OPTIONS = [10, 25, 50, 100, 250];

export function LibraryScreen() {
  const core = useCore();
  const [cache, setCache] = useState<CacheStatus | null>(null);
  const [cacheBusy, setCacheBusy] = useState(false);

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

  if (!core.connection || !core.library) {
    return (
      <main className="shell flex min-h-[72vh] items-center justify-center pb-24 pt-32">
        <div className="max-w-md text-center">
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-faint">Local library</p>
          <h1 className="mt-4 text-4xl font-semibold tracking-[-0.05em] text-fg">Your viewing stays with you.</h1>
          <p className="mt-4 text-sm leading-relaxed text-muted">
            Connect to Cubo Core to see viewing progress, saved titles and local cache usage.
          </p>
          <button
            type="button"
            onClick={core.openSettings}
            className="mt-7 cursor-pointer rounded-full bg-fg px-5 py-2.5 text-sm font-medium text-ink transition hover:bg-accent"
          >
            Connect Core
          </button>
        </div>
      </main>
    );
  }

  const { history, watchLater, analytics } = core.library;
  const continueWatching = history.filter(
    (item) => item.positionSeconds >= 30 && item.progress < 0.9,
  );

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
    if (!core.connection || !window.confirm('Remove all locally cached video?')) return;
    setCacheBusy(true);
    try {
      await clearCache(core.connection);
      await loadCache();
    } finally {
      setCacheBusy(false);
    }
  }

  return (
    <main className="shell pb-28 pt-28 sm:pt-32">
      <header className="max-w-3xl">
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-faint">Local to Cubo Core</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-[-0.05em] text-fg sm:text-6xl">Library</h1>
        <p className="mt-4 max-w-xl text-sm leading-relaxed text-muted">
          Progress, history and saved titles live on the machine running Cubo Core.
        </p>
      </header>

      <section className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-4">
        <Metric label="Time watched" value={formatWatchTime(analytics.totalWatchSeconds)} />
        <Metric label="Play sessions" value={String(analytics.playSessions)} />
        <Metric label="Titles started" value={String(analytics.titlesStarted)} />
        <Metric label="Completed" value={String(analytics.titlesCompleted)} />
      </section>

      <LibraryRow title="Continue watching" items={continueWatching} />
      <SavedRow title="Watch later" items={watchLater} />
      <LibraryRow title="Watch history" items={history.slice(0, 20)} />

      <section className="mt-20 border-t border-line pt-10">
        <div className="flex flex-col gap-8 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-md">
            <div className="flex items-center gap-2.5 text-fg">
              <HardDrives className="size-5" />
              <h2 className="text-xl font-medium tracking-[-0.025em]">Content cache</h2>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-muted">
              Cubo keeps recently streamed pieces locally. When the limit is reached, the oldest cached title is removed first.
            </p>
          </div>

          <div className="w-full max-w-xl rounded-2xl border border-line bg-surface/45 p-5">
            <div className="flex items-end justify-between gap-4">
              <div>
                <p className="text-xs text-faint">Used</p>
                <p className="mt-1 text-2xl font-medium tabular-nums text-fg">
                  {cache ? formatBytes(cache.usedBytes) : '—'}
                </p>
              </div>
              <label className="text-right text-xs text-faint">
                Maximum
                <select
                  value={cache ? Math.round(cache.maxBytes / GIGABYTE) : 50}
                  disabled={cacheBusy || !cache}
                  onChange={(event) => void changeLimit(Number(event.target.value))}
                  className="mt-1 block rounded-full border border-line bg-ink px-3 py-2 text-sm text-fg outline-none"
                >
                  {CACHE_OPTIONS.map((option) => (
                    <option key={option} value={option}>{option} GB</option>
                  ))}
                </select>
              </label>
            </div>

            <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/8">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-500"
                style={{ width: `${cache ? Math.min(100, (cache.usedBytes / cache.maxBytes) * 100) : 0}%` }}
              />
            </div>

            <div className="mt-5 flex items-center justify-between border-t border-line pt-4">
              <p className="text-xs text-faint">{cache?.itemCount ?? 0} cached titles</p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void loadCache()}
                  disabled={cacheBusy}
                  aria-label="Refresh cache usage"
                  className="cursor-pointer rounded-full p-2 text-muted transition hover:bg-white/8 hover:text-fg"
                >
                  <ArrowClockwise className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={() => void removeAllCache()}
                  disabled={cacheBusy || !cache?.itemCount}
                  className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-line px-3.5 py-2 text-xs text-muted transition hover:border-line-strong hover:text-fg disabled:cursor-default disabled:opacity-35"
                >
                  <Trash className="size-3.5" />
                  Clear cache
                </button>
              </div>
            </div>

            {cache?.entries.length ? (
              <ul className="mt-3 m-0 max-h-52 list-none divide-y divide-line overflow-y-auto p-0" data-lenis-prevent>
                {cache.entries.map((entry) => (
                  <li key={entry.infoHash} className="flex items-center justify-between gap-4 py-3">
                    <p className="min-w-0 truncate text-xs text-muted">{entry.title || 'Cached video'}</p>
                    <button
                      type="button"
                      onClick={() => void removeCache(entry.torrentId ?? entry.infoHash)}
                      disabled={cacheBusy}
                      className="shrink-0 cursor-pointer text-[0.7rem] text-faint transition hover:text-fg"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      </section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-ink p-5 sm:p-6">
      <p className="text-xs text-faint">{label}</p>
      <p className="mt-2 text-2xl font-medium tabular-nums tracking-[-0.03em] text-fg">{value}</p>
    </div>
  );
}

function LibraryRow({ title, items }: { title: string; items: LibraryItem[] }) {
  if (!items.length) return null;
  return (
    <section className="mt-16">
      <h2 className="text-xl font-medium tracking-[-0.025em] text-fg">{title}</h2>
      <div className="no-scrollbar -mx-5 mt-5 flex gap-3 overflow-x-auto px-5 pb-2 sm:-mx-2 sm:px-2">
        {items.map((item) => (
          <LibraryCard key={item.key} item={item} />
        ))}
      </div>
    </section>
  );
}

function LibraryCard({ item }: { item: LibraryItem }) {
  const image = posterUrl(item.posterPath, 'w342') || backdropUrl(item.backdropPath, 'w780');
  return (
    <Link href={item.watchHref} className="group w-40 shrink-0 sm:w-48" aria-label={`Continue ${item.title}`}>
      <div className="relative aspect-[2/3] overflow-hidden rounded-2xl border border-line bg-surface">
        {image ? <img src={image} alt="" className="h-full w-full object-cover transition duration-700 group-hover:scale-[1.035]" /> : null}
        <div className="absolute inset-0 bg-linear-to-t from-black via-transparent to-transparent opacity-90" />
        <div className="absolute inset-x-0 bottom-0 p-4">
          <p className="truncate text-sm font-medium text-white">{item.title}</p>
          {item.subtitle ? <p className="mt-1 truncate text-[0.68rem] text-white/55">{item.subtitle}</p> : null}
          <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/20">
            <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(2, item.progress * 100)}%` }} />
          </div>
        </div>
      </div>
    </Link>
  );
}

function SavedRow({ title, items }: { title: string; items: WatchLaterItem[] }) {
  if (!items.length) return null;
  return (
    <section className="mt-16">
      <h2 className="text-xl font-medium tracking-[-0.025em] text-fg">{title}</h2>
      <div className="no-scrollbar -mx-5 mt-5 flex gap-3 overflow-x-auto px-5 pb-2 sm:-mx-2 sm:px-2">
        {items.map((item) => {
          const image = posterUrl(item.posterPath, 'w342');
          return (
            <Link key={item.key} href={item.detailHref} className="group w-40 shrink-0 sm:w-48" aria-label={item.title}>
              <div className="relative aspect-[2/3] overflow-hidden rounded-2xl border border-line bg-surface">
                {image ? <img src={image} alt="" className="h-full w-full object-cover transition duration-700 group-hover:scale-[1.035]" /> : null}
                <div className="absolute inset-0 bg-linear-to-t from-black/90 via-black/5 to-transparent opacity-0 transition duration-500 group-hover:opacity-100" />
                <p className="absolute inset-x-0 bottom-0 translate-y-2 p-4 text-sm font-medium text-white opacity-0 transition duration-500 group-hover:translate-y-0 group-hover:opacity-100">{item.title}</p>
              </div>
            </Link>
          );
        })}
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
