import type { MediaType } from '@cubo/core';
import { useQuery } from '@tanstack/react-query';
import { CatalogError } from '@/components/catalog-error';
import { CatalogLanding } from '@/components/catalog-landing';
import { HeroSkeleton, MediaRowsSkeleton } from '@/components/page-skeletons';
import { tmdbQueries } from '@/lib/queries';
import { useDocumentTitle } from '@/lib/use-document-title';

const COPY: Record<
  MediaType,
  { title: string; sections: [string, string, string, string] }
> = {
  movie: {
    title: 'Movies',
    sections: ['Trending', 'Now Playing', 'Popular Movies', 'Top Rated'],
  },
  tv: {
    title: 'TV Shows',
    sections: ['Trending', 'On The Air', 'Popular TV Shows', 'Top Rated TV'],
  },
};

export function CatalogPage({ mediaType }: { mediaType: MediaType }) {
  const copy = COPY[mediaType];
  useDocumentTitle(copy.title);

  const trending = useQuery(tmdbQueries.trending(mediaType));
  const current = useQuery(tmdbQueries.collection(mediaType, 'current'));
  const popular = useQuery(tmdbQueries.collection(mediaType, 'popular'));
  const topRated = useQuery(tmdbQueries.collection(mediaType, 'top_rated'));
  const featuredId = trending.data?.[0]?.id;
  const featured = useQuery({
    ...tmdbQueries.details(mediaType, featuredId ?? 0),
    enabled: featuredId != null,
  });

  const error = trending.error ?? current.error ?? popular.error ?? topRated.error;
  if (error) {
    return (
      <CatalogError
        message={error instanceof Error ? error.message : 'Could not load the catalogue.'}
      />
    );
  }

  const loading =
    !trending.data ||
    !current.data ||
    !popular.data ||
    !topRated.data ||
    (featuredId != null && featured.isLoading);
  if (loading) return <CatalogSkeleton />;

  const [trendingTitle, currentTitle, popularTitle, topRatedTitle] = copy.sections;
  return (
    <CatalogLanding
      mediaType={mediaType}
      featured={featured.data ?? null}
      sections={[
        { title: trendingTitle, items: trending.data },
        { title: currentTitle, items: current.data },
        { title: popularTitle, items: popular.data },
        { title: topRatedTitle, items: topRated.data },
      ]}
    />
  );
}

function CatalogSkeleton() {
  return (
    <div className="min-h-dvh bg-background text-white">
      <HeroSkeleton />
      <MediaRowsSkeleton rows={4} />
    </div>
  );
}
