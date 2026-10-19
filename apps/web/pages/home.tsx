import { useQuery } from '@tanstack/react-query';
import { CatalogError } from '@/components/catalog-error';
import { ContinueWatching, useContinueWatching } from '@/components/continue-watching';
import { useCore } from '@/components/core-provider';
import { EpisodeStripHero } from '@/components/episode-strip-hero';
import { FeaturedHero } from '@/components/featured-hero';
import { MediaRow } from '@/components/media-row';
import { MotionReveal } from '@/components/motion-reveal';
import { HeroSkeleton, MediaRowsSkeleton } from '@/components/page-skeletons';
import { ServicesRow } from '@/components/services-row';
import { WatchLaterList } from '@/components/watch-later-list';
import { investedInShow } from '@/lib/library';
import { useFeaturedTitle } from '@/lib/use-featured-title';
import { tmdbQueries } from '@/lib/queries';
import { useDocumentTitle } from '@/lib/use-document-title';

export function HomePage() {
  useDocumentTitle(null);
  const { connection, connectionChecked, library } = useCore();

  const movies = useQuery(tmdbQueries.trending('movie'));
  const shows = useQuery(tmdbQueries.trending('tv'));
  const featuredTitle = useFeaturedTitle('home',
    movies.data && shows.data ? [...movies.data, ...shows.data] : null,
  );
  const featuredId = featuredTitle?.id;
  const featured = useQuery({
    ...tmdbQueries.details(featuredTitle?.mediaType ?? 'movie', featuredId ?? 0),
    enabled: featuredId != null,
  });

  // A show in progress takes the hero: the most recent one the viewer is
  // really into with an episode out to play (new episodes lead). A show
  // caught up and waiting on its next episode gives way to the next one.
  const { entries, settled } = useContinueWatching();
  const stripEntry = entries.find(
    (entry) =>
      entry.item.mediaType === 'tv' &&
      entry.kind !== 'waiting' &&
      entry.season != null &&
      entry.episode != null &&
      investedInShow(library?.history, entry.item.mediaId),
  );
  const stripShow = useQuery({
    ...tmdbQueries.details('tv', stripEntry?.item.mediaId ?? 0),
    enabled: stripEntry != null,
  });
  // Decide the hero once the library is known, so it does not swap under
  // the viewer a moment after the page appears.
  const libraryPending =
    !connectionChecked || (connection != null && (library == null || !settled));

  const error = movies.error ?? shows.error;
  if (error) {
    return (
      <CatalogError
        message={error instanceof Error ? error.message : 'Could not load the catalogue.'}
      />
    );
  }

  const strip = stripEntry && stripShow.data ? { entry: stripEntry, show: stripShow.data } : null;
  const loading =
    !movies.data ||
    !shows.data ||
    libraryPending ||
    (stripEntry != null && stripShow.isLoading) ||
    (!strip && (featuredTitle === undefined || (featuredId != null && featured.isLoading)));
  if (loading) return <HomeSkeleton />;

  return (
    <div className="min-h-dvh bg-background text-white" id="top">
      {strip ? (
        <EpisodeStripHero entry={strip.entry} show={strip.show} />
      ) : featured.data ? (
        <FeaturedHero item={featured.data} />
      ) : null}

      <div className="relative space-y-10 px-6 sm:px-10">
        <ServicesRow className="pt-4" />
        <ContinueWatching className="pt-2" excludeKey={strip?.entry.item.key} />
        <WatchLaterList />
        <MotionReveal>
          <section id="movies" className="scroll-mt-24">
            <MediaRow title="Trending" items={movies.data} />
          </section>
        </MotionReveal>
        <MotionReveal>
          <section id="series" className="scroll-mt-24">
            <MediaRow title="Binge-Worthy TV" items={shows.data} />
          </section>
        </MotionReveal>
      </div>
    </div>
  );
}

function HomeSkeleton() {
  return (
    <div className="min-h-dvh bg-background text-white">
      <HeroSkeleton />
      <MediaRowsSkeleton rows={2} />
    </div>
  );
}
