import {
  backdropUrl,
  genresFor,
  logoUrl,
  posterUrl,
  titleHref,
  type DiscoverQuery,
  type MediaSummary,
  type MediaType,
  type WatchProvider,
} from '@cubo/core';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { IoArrowBack } from 'react-icons/io5';
import { ScrollRow } from '@cubo/ui';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { CatalogError } from '@/components/catalog-error';
import { Dropdown } from '@/components/dropdown';
import { Link } from '@/components/link';
import { FeaturedHero } from '@/components/featured-hero';
import { MediaRow } from '@/components/media-row';
import { HeroSkeleton, MediaRowSkeleton } from '@/components/page-skeletons';
import { parseCalendarDate } from '@/lib/air-date';
import { tmdbQueries } from '@/lib/queries';
import {
  catalogRegions,
  findService,
  mergeCatalog,
  regionName,
  type CatalogOrder,
} from '@/lib/streaming-services';
import { useDocumentTitle } from '@/lib/use-document-title';
import { useStreamingServices } from '@/lib/use-streaming-services';

/** How far back "new" reaches for the hero. */
const HERO_RECENT_DAYS = 120;

/** Genre rows under the ranked, new and top-rated ones, in this order.
 *  Kept short: the genre menu reaches the rest. */
const GROUP_GENRES: Record<MediaType, number[]> = {
  tv: [80, 35],
  movie: [28, 35],
};


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

/** Titles from several countries' first pages, merged into one list. */
interface Pooled {
  items: MediaSummary[];
  /** The largest country's match count. */
  total: number;
  loading: boolean;
  failed: boolean;
}

/** A discover query run once per catalogue country and merged in `order`.
 *  TMDB only filters by service within one country at a time. */
function usePooled(
  provider: WatchProvider | undefined,
  regions: string[],
  query: Omit<DiscoverQuery, 'providerIds' | 'region'>,
  order: CatalogOrder,
  enabled = true,
): Pooled {
  const pages = useQueries({
    queries: regions.map((code) => ({
      ...tmdbQueries.discoverPage({ ...query, providerIds: provider?.ids ?? [], region: code }),
      enabled: enabled && provider != null,
    })),
  });
  const data = pages.flatMap((page) => (page.data ? [page.data] : []));
  return {
    items: mergeCatalog(
      data.map((page) => page.results),
      order,
    ),
    total: Math.max(0, ...data.map((page) => page.totalResults)),
    loading: provider == null || pages.some((page) => page.isLoading),
    failed: pages.length > 0 && pages.every((page) => page.isError),
  };
}

/**
 * One streaming service's catalogue, across countries: what is on it in
 * the viewer's country and in the big catalogues (US, UK), merged. Only the
 * Top 10 is the viewer's country alone. Its newest big release leads, then
 * grouped rows. Shows/Movies and genre narrow the page in place; the
 * viewer's other services sit top-right to hop between.
 */
export function ServicePage() {
  const { id } = useParams();
  const providerId = Number(id);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const mediaType: MediaType = params.get('type') === 'movie' ? 'movie' : 'tv';
  const genreId = Number(params.get('genre')) || null;
  const { region, all, services, loading } = useStreamingServices();
  const provider = findService(all, providerId);
  useDocumentTitle(provider?.name ?? 'Services');

  const today = useMemo(() => isoDate(Date.now()), []);
  const recent = useMemo(() => isoDate(Date.now() - HERO_RECENT_DAYS * 86_400_000), []);
  const regions = useMemo(() => (provider ? catalogRegions(provider, region) : []), [provider, region]);
  // The Top 10 ranks by the viewer's country where the service runs there.
  const rankRegion = provider?.priorities[region] != null ? region : regions[0];

  const shows = usePooled(provider, regions, { mediaType: 'tv' }, 'popular');
  const movies = usePooled(provider, regions, { mediaType: 'movie' }, 'popular');
  const newShows = usePooled(
    provider,
    regions,
    { mediaType: 'tv', releasedAfter: recent, releasedBefore: today },
    'popular',
  );
  const newMovies = usePooled(
    provider,
    regions,
    { mediaType: 'movie', releasedAfter: recent, releasedBefore: today },
    'popular',
  );

  const filters = { mediaType, genreIds: genreId ? [genreId] : undefined };
  const top = useQuery({
    ...tmdbQueries.discoverPage({
      ...filters,
      sortBy: 'popular',
      providerIds: provider?.ids ?? [],
      region: rankRegion ?? region,
    }),
    enabled: provider != null && rankRegion != null,
  });
  const fresh = usePooled(
    provider,
    regions,
    { ...filters, sortBy: 'newest', releasedBefore: today, minVoteCount: 5 },
    'newest',
  );

  const hero =
    [newShows, newMovies, shows, movies]
      .flatMap((pool) => pool.items)
      .find((item) => item.backdropPath) ?? null;
  const heroLoading = !hero && [newShows, newMovies, shows, movies].some((pool) => pool.loading);
  const heroDetails = useQuery({
    ...tmdbQueries.details(hero?.mediaType ?? 'tv', hero?.id ?? 0),
    enabled: hero != null,
  });

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
            ? 'Cubo does not know that service.'
            : 'Streaming availability is not available right now.'
        }
      />
    );
  }

  const genres = genresFor(mediaType);
  // Hop between the viewer's services from the header; the one on screen
  // stays in the list even when it is not one of theirs.
  const switchList = [
    ...(provider && !services.includes(provider) ? [provider] : []),
    ...services,
  ];
  const groups = genreId
    ? []
    : GROUP_GENRES[mediaType].flatMap((id) => genres.filter((genre) => genre.id === id));

  return (
    <main className="min-h-dvh bg-background pb-16 text-white">
      <div className="relative">
        {heroDetails.data && provider ? (
          <FeaturedHero item={heroDetails.data} kind={`New on ${provider.name}`} />
        ) : heroLoading || heroDetails.isLoading || !provider ? (
          <HeroSkeleton />
        ) : null}

        <div className="absolute inset-x-0 top-20 z-20 flex flex-wrap items-center gap-4 px-6 sm:px-10">
          <button
            type="button"
            onClick={back}
            aria-label="Back"
            className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full border border-white/10 bg-white/10 backdrop-blur-sm transition-colors hover:bg-white/20"
          >
            <IoArrowBack size={18} />
          </button>
          <h1 className="sr-only">{provider?.name ?? ''}</h1>
          {provider ? (
            <ServiceSwitcher
              current={provider}
              services={switchList}
              suffix={mediaType === 'movie' ? '?type=movie' : ''}
            />
          ) : null}
        </div>
      </div>

      <div className="relative space-y-10 px-6 pt-4 sm:px-10">
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
          <Dropdown
            ariaLabel="Genre"
            value={genreId ?? 0}
            options={[
              { value: 0, label: 'All genres' },
              ...genres.map((genre) => ({ value: genre.id, label: genre.name })),
            ]}
            onChange={(value) => update({ genre: value ? String(value) : null })}
          />
        </div>

        <section className="space-y-5">
          <h2 className="text-3xl font-bold">
            Top 10 on {provider?.name}
            {rankRegion ? (
              <span className="ml-3 text-base font-semibold text-faint">{regionName(rankRegion)}</span>
            ) : null}
          </h2>
          {top.data?.results.length ? (
            <TopTen items={top.data.results.filter((item) => item.posterPath).slice(0, 10)} />
          ) : (
            <RowPlaceholder loading={!top.isError} tall />
          )}
        </section>

        <section className="space-y-5">
          <h2 className="text-3xl font-bold">New on {provider?.name}</h2>
          {fresh.items.length ? (
            <div>
              <ScrollRow className="gap-4 pt-2 pb-2" label={`New on ${provider?.name}`}>
                {fresh.items.slice(0, 12).map((item) => (
                  <NewCard key={item.id} item={item} date={shortDate(item.releaseDate)} />
                ))}
              </ScrollRow>
            </div>
          ) : (
            <RowPlaceholder loading={fresh.loading} />
          )}
        </section>

        {provider ? (
          <>
            <GroupRow
              title="Top rated"
              provider={provider}
              regions={regions}
              query={{ ...filters, sortBy: 'rating', minVoteCount: 100 }}
              order="rating"
            />
            {groups.map((genre) => (
              <GroupRow
                key={`${mediaType}:${genre.id}`}
                title={genre.name}
                provider={provider}
                regions={regions}
                query={{ ...filters, genreIds: [genre.id], sortBy: 'popular' }}
                order="popular"
              />
            ))}
          </>
        ) : null}
      </div>
    </main>
  );
}

/** The viewer's services as one bar of logos: the one on screen is lit
 *  and named, the rest stay dim until hovered and open their page. */
function ServiceSwitcher({
  current,
  services,
  suffix,
}: {
  current: WatchProvider;
  services: WatchProvider[];
  suffix: string;
}) {
  return (
    <nav
      aria-label="Your services"
      className="flex items-center gap-1 rounded-full border border-white/10 bg-black/30 p-1 backdrop-blur-md"
    >
      {services.map((entry) => {
        const active = entry.id === current.id;
        return (
          <Link
            key={entry.id}
            href={`/services/${entry.id}${suffix}`}
            aria-label={entry.name}
            aria-current={active ? 'page' : undefined}
            className={`group flex h-9 cursor-pointer items-center gap-2.5 rounded-full p-1 transition-[background-color,opacity] duration-500 ${
              active ? 'bg-white/[0.14] pr-4' : 'opacity-50 hover:bg-white/[0.08] hover:opacity-100'
            }`}
          >
            {entry.logoPath ? (
              <img
                src={logoUrl(entry.logoPath, 'w300')}
                alt=""
                className="h-7 w-7 rounded-full object-cover"
              />
            ) : (
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-control text-[11px] font-semibold">
                {entry.name.slice(0, 2)}
              </span>
            )}
            {active ? (
              <span className="service-name text-sm font-semibold whitespace-nowrap">{entry.name}</span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

/** Posters behind outlined rank numerals. */
function TopTen({ items }: { items: MediaSummary[] }) {
  return (
    <div>
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

/** Continue Watching's card: the title's logo over its still, with a
 *  frosted pill for when it arrived on the service. */
function NewCard({ item, date }: { item: MediaSummary; date: string | null }) {
  const details = useQuery(tmdbQueries.details(item.mediaType, item.id));
  const [logoFailed, setLogoFailed] = useState(false);
  const logo = logoFailed ? '' : logoUrl(details.data?.logoPath ?? null, 'w300');

  return (
    <Link
      href={titleHref(item)}
      aria-label={date ? `${item.title}, new ${date}` : item.title}
      className="group block w-72 shrink-0 cursor-pointer sm:w-80"
    >
      <span className="relative block aspect-video overflow-hidden rounded-xl bg-white/[0.06] shadow-[0_12px_30px_rgba(0,0,0,0.28)]">
        {item.backdropPath ? (
          <img
            src={backdropUrl(item.backdropPath, 'w780')}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        ) : null}
        <span className="absolute inset-0 bg-linear-to-t from-black/80 via-black/20 to-transparent" />
        {date ? (
          <span className="absolute left-3 top-3 z-10 flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-xs font-semibold text-white backdrop-blur-md">
            <span aria-hidden className="size-1.5 rounded-full bg-white" />
            {date}
          </span>
        ) : null}
        <span className="absolute inset-x-0 bottom-0 p-4">
          {details.isLoading ? null : logo ? (
            <img
              src={logo}
              alt=""
              onError={() => setLogoFailed(true)}
              className="max-h-16 max-w-[72%] object-contain object-left-bottom"
            />
          ) : (
            <span className="line-clamp-2 max-w-[72%] text-xl font-semibold leading-tight text-white">
              {item.title}
            </span>
          )}
        </span>
      </span>
    </Link>
  );
}

/** True once `ref` comes within a screen or so of the viewport, so rows far
 *  down the page only fetch when the viewer heads their way. */
function useNearViewport(ref: RefObject<HTMLElement | null>): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || near) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin: '800px 0px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, near]);
  return near;
}

/** A titled row of posters for one slice of the service's catalogue;
 *  disappears when that slice is empty. */
function GroupRow({
  title,
  provider,
  regions,
  query,
  order,
}: {
  title: string;
  provider: WatchProvider;
  regions: string[];
  query: Omit<DiscoverQuery, 'providerIds' | 'region'>;
  order: CatalogOrder;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const near = useNearViewport(ref);
  const pool = usePooled(provider, regions, query, order, near);
  const items = pool.items.filter((item) => item.posterPath);
  if (pool.failed || (near && !pool.loading && items.length === 0)) return null;

  return (
    <div ref={ref}>
      {items.length ? <MediaRow title={title} items={items} /> : <MediaRowSkeleton />}
    </div>
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
