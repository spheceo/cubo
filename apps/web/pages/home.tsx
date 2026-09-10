import { useQuery } from '@tanstack/react-query';
import { CatalogError } from '@/components/catalog-error';
import { ContinueWatching } from '@/components/continue-watching';
import { FeaturedHero } from '@/components/featured-hero';
import { MediaRow } from '@/components/media-row';
import { MotionReveal } from '@/components/motion-reveal';
import { HeroSkeleton, MediaRowsSkeleton } from '@/components/page-skeletons';
import { WatchLaterList } from '@/components/watch-later-list';
import { useFeaturedTitle } from '@/lib/use-featured-title';
import { tmdbQueries } from '@/lib/queries';
import { useDocumentTitle } from '@/lib/use-document-title';

export function HomePage() {
  useDocumentTitle(null);

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

  const error = movies.error ?? shows.error;
  if (error) {
    return (
      <CatalogError
        message={error instanceof Error ? error.message : 'Could not load the catalogue.'}
      />
    );
  }

  const loading =
    !movies.data || !shows.data || featuredTitle === undefined || (featuredId != null && featured.isLoading);
  if (loading) return <HomeSkeleton />;

  return (
    <div className="min-h-dvh bg-background text-white" id="top">
      {featured.data ? <FeaturedHero item={featured.data} /> : null}

      <div className="relative space-y-10 px-6 sm:px-10">
        <ContinueWatching className="pt-2" />
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
