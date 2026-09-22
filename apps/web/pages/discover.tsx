import { genresFor, titleHref } from '@cubo/core';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { IoShuffle } from 'react-icons/io5';
import { useNavigate, useSearchParams } from 'react-router';
import { useCore } from '@/components/core-provider';
import { Dropdown } from '@/components/dropdown';
import { MediaGrid } from '@/components/media-grid';
import { MediaGridSkeleton } from '@/components/page-skeletons';
import { catalog } from '@/lib/api';
import {
  DEFAULT_FILTERS,
  ERAS,
  filtersToParams,
  filtersToQuery,
  matchesFilters,
  MIN_VOTES,
  parseDiscoverParams,
  PRESETS,
  sameFilters,
  SORTS,
  type DiscoverFilters,
} from '@/lib/discover-filters';
import { queryClient, tmdbQueries } from '@/lib/queries';
import { useDocumentTitle } from '@/lib/use-document-title';

export function DiscoverPage() {
  useDocumentTitle('Discover');
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { library } = useCore();
  const filters = useMemo(() => parseDiscoverParams(searchParams), [searchParams]);
  const query = useMemo(() => filtersToQuery(filters), [filters]);
  const genres = genresFor(filters.mediaType);

  const results = useInfiniteQuery(tmdbQueries.discover(query));
  const items = useMemo(() => {
    const seen = new Set<number>();
    return (results.data?.pages ?? [])
      .flatMap((page) => page.results)
      .filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
  }, [results.data]);

  const update = (patch: Partial<DiscoverFilters>) =>
    setSearchParams(filtersToParams({ ...filters, ...patch }), { preventScrollReset: true });

  // Random pick from anywhere in the first ten pages of the current filters —
  // the slot-machine path for people who don't want to browse. When there's
  // watch history, related titles of recently-watched entries get first bid.
  const [surprising, setSurprising] = useState(false);
  const [surpriseError, setSurpriseError] = useState(false);
  /** Tries up to three recently-watched titles as recommendation seeds; a
   *  seed wins when it yields an unseen title matching the active filters. */
  async function surpriseFromHistory(): Promise<boolean> {
    const history = library?.history ?? [];
    const knownIds = new Set([
      ...history.map((item) => item.mediaId),
      ...(library?.watchLater ?? []).map((item) => item.mediaId),
    ]);
    const seeds = [
      ...new Set(
        history
          .filter((item) => item.mediaType === filters.mediaType)
          .sort((a, b) => b.lastWatchedAt - a.lastWatchedAt)
          .map((item) => item.mediaId),
      ),
    ]
      .slice(0, 8)
      .sort(() => Math.random() - 0.5)
      .slice(0, 3);

    for (const seed of seeds) {
      try {
        const related = await queryClient.fetchQuery({
          queryKey: ['tmdb', 'related', filters.mediaType, seed],
          queryFn: () => catalog.tmdb.related(filters.mediaType, seed),
          staleTime: 30 * 60 * 1000,
        });
        const pool = related.filter(
          (item) => !knownIds.has(item.id) && matchesFilters(item, filters),
        );
        const pick = pool[Math.floor(Math.random() * pool.length)];
        if (pick) {
          navigate(titleHref(pick));
          return true;
        }
      } catch {
        // One dead seed shouldn't sink the feature — try the next title.
      }
    }
    return false;
  }

  async function surpriseMe() {
    if (surprising) return;
    setSurprising(true);
    setSurpriseError(false);
    try {
      if (await surpriseFromHistory()) return;
      const first = await queryClient.fetchQuery({
        queryKey: ['tmdb', 'discover', 'page', { ...query, page: 1 }],
        queryFn: () => catalog.tmdb.discover({ ...query, page: 1 }),
      });
      const pages = Math.min(Math.max(first.totalPages, 1), 10);
      const pageNumber = 1 + Math.floor(Math.random() * pages);
      const picked =
        pageNumber === 1
          ? first
          : await queryClient.fetchQuery({
              queryKey: ['tmdb', 'discover', 'page', { ...query, page: pageNumber }],
              queryFn: () => catalog.tmdb.discover({ ...query, page: pageNumber }),
            });
      const pool = picked.results;
      const item = pool[Math.floor(Math.random() * pool.length)];
      if (!item) throw new Error('empty pick pool');
      navigate(titleHref(item));
    } catch {
      setSurpriseError(true);
    } finally {
      setSurprising(false);
    }
  }

  // Auto-load the next page when the grid's tail scrolls into view; the
  // button below remains the keyboard-accessible path.
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !results.hasNextPage) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void results.fetchNextPage();
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [results.hasNextPage, results.fetchNextPage]);

  const error = results.error;
  const loading = results.isLoading;
  const activePresetId = PRESETS.find((preset) =>
    sameFilters(filters, preset.apply(filters)),
  )?.id;
  const filterActive = !sameFilters(filters, { ...DEFAULT_FILTERS, mediaType: filters.mediaType });

  return (
    <main className="min-h-dvh bg-background px-6 pb-16 pt-24 text-white sm:px-10">
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-bold tracking-tight">Discover</h1>
        <button
          type="button"
          onClick={() => void surpriseMe()}
          disabled={surprising}
          className="ml-auto flex cursor-pointer items-center gap-2 rounded-full bg-control px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-control-hover disabled:opacity-50"
        >
          <IoShuffle size={16} />
          {surprising ? 'Picking…' : 'Surprise me'}
        </button>
        {surpriseError ? (
          <span className="basis-full text-sm text-white/60">
            Couldn't find a pick — try loosening a filter or two.
          </span>
        ) : null}
      </div>

      <div className="mb-8 flex flex-wrap items-center gap-3">
        <div className="flex rounded-full bg-control p-1" role="tablist" aria-label="Media type">
          {(['movie', 'tv'] as const).map((type) => (
            <button
              key={type}
              type="button"
              role="tab"
              aria-selected={filters.mediaType === type}
              onClick={() => update({ mediaType: type, genreIds: [] })}
              className={`cursor-pointer rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                filters.mediaType === type ? 'bg-white text-black' : 'text-white/60 hover:text-white'
              }`}
            >
              {type === 'movie' ? 'Movies' : 'TV Shows'}
            </button>
          ))}
        </div>

        <Dropdown
          value={activePresetId ?? ''}
          options={PRESETS.map((preset) => ({ value: preset.id, label: preset.label }))}
          onChange={(id) => {
            const preset = PRESETS.find((entry) => entry.id === id);
            if (preset) {
              setSearchParams(filtersToParams(preset.apply(filters)), {
                preventScrollReset: true,
              });
            }
          }}
          placeholder="Quick picks"
          ariaLabel="Quick picks"
          className="w-auto min-w-36"
        />
        <Dropdown
          multiple
          value={filters.genreIds}
          options={genres.map((genre) => ({ value: genre.id, label: genre.name }))}
          onChange={(genreIds) => update({ genreIds })}
          placeholder="All genres"
          ariaLabel="Genres"
          className="w-auto min-w-36 max-w-56"
        />
        <Dropdown
          value={filters.era}
          options={[...ERAS]}
          onChange={(era) => update({ era })}
          ariaLabel="Era"
          className="w-auto min-w-32"
        />
        <Dropdown
          value={filters.minVote ?? 0}
          options={MIN_VOTES.map((entry) => ({ value: entry.value, label: entry.label }))}
          onChange={(value) => update({ minVote: value === 0 ? null : value })}
          ariaLabel="Minimum rating"
          className="w-auto min-w-36"
        />
        <Dropdown
          value={filters.sortBy}
          options={SORTS}
          onChange={(sortBy) => update({ sortBy })}
          ariaLabel="Sort by"
          className="w-auto min-w-40"
        />
        {filterActive ? (
          <button
            type="button"
            onClick={() =>
              setSearchParams(filtersToParams({ ...DEFAULT_FILTERS, mediaType: filters.mediaType }), {
                preventScrollReset: true,
              })
            }
            className="cursor-pointer rounded-full px-3 py-1.5 text-sm text-white/50 transition-colors hover:text-white"
          >
            Reset
          </button>
        ) : null}
      </div>

      {error ? (
        <p className="text-white/60">
          {error instanceof Error ? error.message : 'Could not load the catalogue.'}
        </p>
      ) : loading ? (
        <MediaGridSkeleton />
      ) : items.length === 0 ? (
        <p className="text-white/60">
          Nothing matches that combination — loosen a filter or two.
        </p>
      ) : (
        <>
          <MediaGrid items={items} />
          {results.hasNextPage ? (
            <div ref={sentinelRef} className="flex justify-center pt-10">
              <button
                type="button"
                onClick={() => void results.fetchNextPage()}
                disabled={results.isFetchingNextPage}
                className="cursor-pointer rounded-full bg-control px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-control-hover disabled:opacity-50"
              >
                {results.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </button>
            </div>
          ) : null}
        </>
      )}
    </main>
  );
}
