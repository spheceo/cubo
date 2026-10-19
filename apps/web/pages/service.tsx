import {
  backdropUrl,
  genresFor,
  logoUrl,
  posterUrl,
  titleHref,
  watchHref,
  type DiscoverPage,
  type DiscoverSort,
  type MediaSummary,
  type MediaType,
} from '@cubo/core';
import {
  useInfiniteQuery,
  useQuery,
  type InfiniteData,
  type UseInfiniteQueryResult,
} from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';
import { IoArrowBack, IoPlay } from 'react-icons/io5';
import { IoMdInformationCircleOutline } from 'react-icons/io';
import { ScrollRow } from '@cubo/ui';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { CatalogError } from '@/components/catalog-error';
import { useCore } from '@/components/core-provider';
import { Dropdown } from '@/components/dropdown';
import { Link } from '@/components/link';
import { MediaGrid } from '@/components/media-grid';
import { HeroSkeleton, MediaGridSkeleton } from '@/components/page-skeletons';
import { WatchLaterButton } from '@/components/watch-later-button';
import { parseCalendarDate } from '@/lib/air-date';
import { SORTS } from '@/lib/discover-filters';
import { latestHistoryForTitle, playButtonLabel, watchLaterItem } from '@/lib/library';
import { tmdbQueries } from '@/lib/queries';
import { regionName } from '@/lib/streaming-services';
import { useDocumentTitle } from '@/lib/use-document-title';
import { useStreamingServices } from '@/lib/use-streaming-services';

/** How far back "new" reaches for the hero. */
const HERO_RECENT_DAYS = 120;

function isoDate(time: number): string {
  const date = new Date(time);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** "Oct 16" for a release date this year, "Oct 16, 2025" otherwise. */
function shortDate(value: string): string | null {
  const date = parseCalendarDate(value);
  if (!date) return null;
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/**
 * One subscription service's catalogue in the viewer's country: its newest
 * big release up top, then its most popular and newest titles, then all of
 * it. Shows/Movies and genre narrow the page in place; the viewer's other
 * services sit top-right to hop between.
 */
export function ServicePage() {
  const { id } = useParams();
  const providerId = Number(id);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const mediaType: MediaType = params.get('type') === 'movie' ? 'movie' : 'tv';
  const genreId = Number(params.get('genre')) || null;
  const sort = (SORTS.find((entry) => entry.value === params.get('sort'))?.value ??
    'popular') as DiscoverSort;
  const { region, all, services, loading } = useStreamingServices();
  const provider = all.find((entry) => entry.id === providerId);
  useDocumentTitle(provider?.name ?? 'Services');

  const today = useMemo(() => isoDate(Date.now()), []);
  const recent = useMemo(() => isoDate(Date.now() - HERO_RECENT_DAYS * 86_400_000), []);
  const base = { providerIds: [providerId], region };
  const ready = provider != null;

  const shows = useQuery({ ...tmdbQueries.discoverPage({ mediaType: 'tv', ...base }), enabled: ready });
  const movies = useQuery({ ...tmdbQueries.discoverPage({ mediaType: 'movie', ...base }), enabled: ready });
  const newShows = useQuery({
    ...tmdbQueries.discoverPage({ mediaType: 'tv', ...base, releasedAfter: recent, releasedBefore: today }),
    enabled: ready,
  });
  const newMovies = useQuery({
    ...tmdbQueries.discoverPage({ mediaType: 'movie', ...base, releasedAfter: recent, releasedBefore: today }),
    enabled: ready,
  });

  const filters = {
    mediaType,
    ...base,
    genreIds: genreId ? [genreId] : undefined,
  };
  const top = useQuery({ ...tmdbQueries.discoverPage({ ...filters, sortBy: 'popular' }), enabled: ready });
  const fresh = useQuery({
    ...tmdbQueries.discoverPage({ ...filters, sortBy: 'newest', releasedBefore: today, minVoteCount: 5 }),
    enabled: ready,
  });
  const everything = useInfiniteQuery({ ...tmdbQueries.discover({ ...filters, sortBy: sort }), enabled: ready });

  const hero =
    [newShows.data, newMovies.data, shows.data, movies.data]
      .flatMap((page) => page?.results ?? [])
      .find((item) => item.backdropPath) ?? null;
  const heroLoading = !hero && [newShows, newMovies, shows, movies].some((query) => query.isLoading);

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(patch)) {
      if (value == null) next.delete(key);
      else next.set(key, value);
    }
    setParams(next, { preventScrollReset: true, replace: true });
  };

  const back = () => {
    const index = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (index > 0) navigate(-1);
    else navigate('/');
  };

  if (!loading && !provider) {
    return (
      <CatalogError
        message={
          all.length
            ? `That service has no catalogue in ${regionName(region)}.`
            : 'Streaming availability is not available right now.'
        }
      />
    );
  }

  const total = (shows.data?.totalResults ?? 0) + (movies.data?.totalResults ?? 0);
  const genres = genresFor(mediaType);
  const kindLabel = mediaType === 'tv' ? 'Shows' : 'Movies';

  return (
    <main className="min-h-dvh bg-background pb-16 text-white">
      <div className="relative h-[78dvh] min-h-[600px] overflow-hidden">
        {heroLoading || !provider ? (
          <HeroSkeleton />
        ) : hero ? (
          <ServiceHero item={hero} providerName={provider.name} />
        ) : null}

        <div className="absolute inset-x-0 top-24 z-20 flex flex-wrap items-center gap-4 px-6 sm:px-10">
          <button
            type="button"
            onClick={back}
            aria-label="Back"
            className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full border border-white/10 bg-white/10 backdrop-blur-sm transition-colors hover:bg-white/20"
          >
            <IoArrowBack size={18} />
          </button>
          {provider?.logoPath ? (
            <img src={logoUrl(provider.logoPath, 'w300')} alt="" className="h-12 w-12 rounded-xl" />
          ) : null}
          <div>
            <h1 className="text-xl font-semibold tracking-[-0.02em]">{provider?.name ?? ' '}</h1>
            <p className="text-sm text-white/60">
              {total ? `${total.toLocaleString()} titles in ${regionName(region)}` : regionName(region)}
            </p>
          </div>
          {services.length > 1 ? (
            <nav aria-label="Your services" className="ml-auto hidden items-center gap-2.5 sm:flex">
              {services.map((entry) => (
                <Link
                  key={entry.id}
                  href={`/services/${entry.id}${mediaType === 'movie' ? '?type=movie' : ''}`}
                  aria-label={entry.name}
                  aria-current={entry.id === providerId ? 'page' : undefined}
                  className={`block cursor-pointer rounded-[10px] transition-opacity ${
                    entry.id === providerId
                      ? 'shadow-[0_0_0_2px_#0a0a0a,0_0_0_4px_#fff]'
                      : 'opacity-55 hover:opacity-100'
                  }`}
                >
                  {entry.logoPath ? (
                    <img src={logoUrl(entry.logoPath, 'w300')} alt="" className="h-10 w-10 rounded-[10px]" />
                  ) : (
                    <span className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-control text-xs font-semibold">
                      {entry.name.slice(0, 2)}
                    </span>
                  )}
                </Link>
              ))}
            </nav>
          ) : null}
        </div>
      </div>

      <div className="relative z-10 -mt-6 space-y-12 px-6 sm:px-10">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex rounded-full bg-control p-1" role="tablist" aria-label="Media type">
            {(['tv', 'movie'] as const).map((type) => (
              <button
                key={type}
                type="button"
                role="tab"
                aria-selected={mediaType === type}
                onClick={() => update({ type: type === 'movie' ? 'movie' : null, genre: null })}
                className={`cursor-pointer rounded-full px-4 py-1.5 text-sm font-semibold transition-colors ${
                  mediaType === type ? 'bg-white text-black' : 'text-muted hover:text-white'
                }`}
              >
                {type === 'tv' ? 'Shows' : 'Movies'}
              </button>
            ))}
          </div>
          <span aria-hidden className="mx-1.5 h-6 w-px bg-line-strong" />
          <div className="no-scrollbar -mx-1 flex min-w-0 flex-1 gap-2 overflow-x-auto px-1">
            <GenreChip label="All" active={genreId == null} onClick={() => update({ genre: null })} />
            {genres.map((genre) => (
              <GenreChip
                key={genre.id}
                label={genre.name}
                active={genreId === genre.id}
                onClick={() => update({ genre: String(genre.id) })}
              />
            ))}
          </div>
        </div>

        <section>
          <h2 className="text-2xl font-semibold">Most popular on {provider?.name}</h2>
          {top.data?.results.length ? (
            <TopTen items={top.data.results.slice(0, 10)} />
          ) : (
            <RowPlaceholder loading={top.isLoading} tall />
          )}
        </section>

        <section>
          <h2 className="text-2xl font-semibold">New on {provider?.name}</h2>
          {fresh.data?.results.length ? (
            <div className="mt-2">
              <ScrollRow className="gap-4 pt-2 pb-2" label={`New on ${provider?.name}`}>
                {fresh.data.results.slice(0, 12).map((item) => (
                  <BackdropCard key={item.id} item={item} badge={shortDate(item.releaseDate)} />
                ))}
              </ScrollRow>
            </div>
          ) : (
            <RowPlaceholder loading={fresh.isLoading} />
          )}
        </section>

        <section>
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-2xl font-semibold">
              All {kindLabel.toLowerCase()} on {provider?.name}
            </h2>
            <Dropdown
              className="ml-auto"
              ariaLabel="Sort"
              value={sort}
              options={SORTS.map((entry) => ({ value: entry.value, label: entry.label }))}
              onChange={(value) => update({ sort: value === 'popular' ? null : value })}
            />
          </div>
          <div className="mt-4">
            <EverythingGrid query={everything} />
          </div>
        </section>
      </div>
    </main>
  );
}

function ServiceHero({ item, providerName }: { item: MediaSummary; providerName: string }) {
  const { library } = useCore();
  const details = useQuery(tmdbQueries.details(item.mediaType, item.id));
  const resume = latestHistoryForTitle(library?.history, item.mediaType, item.id);
  const playHref =
    item.mediaType === 'tv'
      ? watchHref(item, resume?.season ?? 1, resume?.episode ?? 1)
      : watchHref(item);
  const year = item.releaseDate.slice(0, 4);

  return (
    <>
      <img
        src={backdropUrl(item.backdropPath, 'w1280')}
        alt=""
        fetchPriority="high"
        className="absolute inset-y-0 right-0 h-full w-full object-cover lg:w-[76%]"
      />
      <div className="pointer-events-none absolute inset-0 bg-linear-to-r from-background via-background/70 via-35% to-transparent to-70%" />
      <div className="pointer-events-none absolute inset-0 bg-linear-to-t from-background via-background/60 via-20% to-transparent to-50%" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-48 bg-linear-to-b from-background/80 to-transparent" />

      <div className="absolute inset-x-0 bottom-16 z-10 px-6 sm:px-10">
        <div className="max-w-xl">
          <p className="font-mono text-xs uppercase tracking-[0.14em] text-white/70">
            New on {providerName}
          </p>
          <h2 className="mt-3 text-5xl font-medium leading-none tracking-[-0.04em] sm:text-7xl">
            {item.title}
          </h2>
          <p className="mt-4 text-muted">
            {[year, item.mediaType === 'tv' ? 'Series' : 'Movie', item.voteAverage ? `★ ${item.voteAverage.toFixed(1)}` : null]
              .filter(Boolean)
              .join(' · ')}
          </p>
          <p className="mt-3 line-clamp-3 text-base leading-relaxed text-faint sm:text-lg">{item.overview}</p>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Link
              href={playHref}
              className="flex h-12 cursor-pointer items-center gap-2.5 rounded-full bg-white px-6 font-semibold text-black transition-colors hover:bg-white/85"
            >
              <IoPlay size={20} />
              {playButtonLabel(item.mediaType, resume)}
            </Link>
            {details.data ? <WatchLaterButton item={watchLaterItem(details.data)} /> : null}
            <Link
              href={titleHref(item)}
              aria-label={`More information about ${item.title}`}
              className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-full bg-control"
            >
              <IoMdInformationCircleOutline size={25} />
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}

function GenreChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`h-9 shrink-0 cursor-pointer rounded-full px-4 text-sm font-semibold whitespace-nowrap transition-colors ${
        active ? 'bg-white text-black' : 'bg-surface text-white hover:bg-control'
      }`}
    >
      {label}
    </button>
  );
}

/** Posters behind outlined rank numerals. */
function TopTen({ items }: { items: MediaSummary[] }) {
  return (
    <div className="mt-2">
      <ScrollRow className="gap-1.5 pt-2 pb-2" label="Ranked">
        {items.map((item, index) => (
          <Link
            key={item.id}
            href={titleHref(item)}
            aria-label={`${index + 1}. ${item.title}`}
            className="group flex shrink-0 cursor-pointer items-end"
          >
            <span
              aria-hidden
              className="-mr-5 text-[9rem] leading-[0.78] font-bold tracking-[-0.06em] text-transparent [-webkit-text-stroke:2px_rgb(255_255_255/0.18)] sm:text-[11rem]"
            >
              {index + 1}
            </span>
            <span className="relative block aspect-[2/3] w-32 overflow-hidden rounded-xl bg-surface transition-transform duration-500 ease-[cubic-bezier(.22,1,.36,1)] group-hover:-translate-y-1.5 sm:w-[150px]">
              {item.posterPath ? (
                <img src={posterUrl(item.posterPath, 'w342')} alt="" loading="lazy" className="h-full w-full object-cover" />
              ) : null}
            </span>
          </Link>
        ))}
      </ScrollRow>
    </div>
  );
}

function BackdropCard({ item, badge }: { item: MediaSummary; badge: string | null }) {
  return (
    <Link href={titleHref(item)} className="group block w-64 shrink-0 cursor-pointer sm:w-[264px]">
      <span className="relative block aspect-video overflow-hidden rounded-xl bg-surface transition-transform duration-500 ease-[cubic-bezier(.22,1,.36,1)] group-hover:-translate-y-1.5">
        {item.backdropPath ? (
          <img src={backdropUrl(item.backdropPath, 'w780')} alt="" loading="lazy" className="h-full w-full object-cover" />
        ) : null}
        {badge ? (
          <span className="absolute left-2.5 top-2.5 rounded-md bg-black/70 px-2 py-1 font-mono text-[11px] uppercase tracking-[0.08em]">
            {badge}
          </span>
        ) : null}
      </span>
      <span className="mt-2.5 block truncate font-semibold">{item.title}</span>
    </Link>
  );
}

function RowPlaceholder({ loading, tall = false }: { loading: boolean; tall?: boolean }) {
  if (!loading) return <p className="mt-4 text-sm text-faint">Nothing here for this genre.</p>;
  return (
    <div className="mt-4 flex gap-4 overflow-hidden">
      {Array.from({ length: 6 }, (_, index) => (
        <div
          key={index}
          className={`shrink-0 animate-pulse rounded-xl bg-white/[0.06] ${tall ? 'aspect-[2/3] w-[150px]' : 'aspect-video w-[264px]'}`}
        />
      ))}
    </div>
  );
}

function EverythingGrid({
  query,
}: {
  query: UseInfiniteQueryResult<InfiniteData<DiscoverPage>>;
}) {
  const items = useMemo(() => {
    const seen = new Set<number>();
    return (query.data?.pages ?? [])
      .flatMap((page) => page.results)
      .filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
  }, [query.data]);

  // Auto-load the next page when the grid's tail scrolls into view; the
  // button below remains the keyboard-accessible path.
  const sentinelRef = useRef<HTMLDivElement>(null);
  const { hasNextPage, fetchNextPage } = query;
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasNextPage) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void fetchNextPage();
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasNextPage, fetchNextPage]);

  if (query.isLoading) return <MediaGridSkeleton />;
  if (query.error) {
    return <p className="text-sm text-faint">Could not load this catalogue.</p>;
  }
  if (!items.length) return <p className="text-sm text-faint">Nothing here for this genre.</p>;

  return (
    <>
      <MediaGrid items={items} />
      <div ref={sentinelRef} />
      {query.hasNextPage ? (
        <div className="mt-8 flex justify-center">
          <button
            type="button"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
            className="cursor-pointer rounded-full bg-control px-6 py-2.5 font-semibold transition-colors hover:bg-control-hover disabled:cursor-wait disabled:opacity-60"
          >
            {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        </div>
      ) : null}
    </>
  );
}
