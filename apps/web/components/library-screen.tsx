import type { MediaSummary, WatchLaterItem } from '@cubo/core';
import { MediaCard } from '@cubo/ui';
import { useCallback, useEffect, useState } from 'react';
import { ContinueWatching } from '@/components/continue-watching';
import { Link } from '@/components/link';
import { asMediaSummary } from '@/lib/format';
import { getCacheStatus, type CacheStatus } from '@/lib/local-engine';
import { useCore } from './core-provider';

const GIGABYTE = 1024 ** 3;

/**
 * The viewer-facing side of the library: resume, saved and history. Machine
 * administration (cache budget/folder, system stats) lives in the Core
 * dialog — this page only whispers a usage summary with a link to it.
 */
export function LibraryScreen() {
  const core = useCore();
  const [cache, setCache] = useState<CacheStatus | null>(null);

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
            Connect to Cubo Core to see viewing progress, saved titles and your watch history.
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

  return (
    <main className="min-h-dvh space-y-16 bg-background px-6 pb-24 pt-28 text-white sm:px-10">
      <header>
        <p className="text-xl font-semibold text-white/50">LOCAL TO CUBO CORE</p>
        <h1 className="mt-3 text-5xl font-bold sm:text-6xl">Library</h1>
        <p className="mt-4 text-sm text-faint">
          {formatWatchTime(analytics.totalWatchSeconds)} watched ·{' '}
          {analytics.titlesStarted} titles started · {analytics.titlesCompleted} finished
        </p>
      </header>

      <ContinueWatching className="" />
      <SavedGrid title="Watch Later" items={watchLater} />
      <HistoryGrid items={history.slice(0, 16)} />

      <section className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-8">
        <p className="text-sm text-faint">
          {cache
            ? `Content cache · ${formatBytes(cache.usedBytes)} of ${Math.round(cache.maxBytes / GIGABYTE)} GB used`
            : 'Content cache'}
        </p>
        <button
          type="button"
          onClick={core.openSettings}
          className="cursor-pointer border-0 bg-transparent p-0 text-sm font-semibold text-muted transition-colors hover:text-white"
        >
          Manage in Core
        </button>
      </section>
    </main>
  );
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
            item={asMediaSummary(item)}
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
              item={asMediaSummary(item)}
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
