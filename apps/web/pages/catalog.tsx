import type { MediaDetails, MediaSummary, MediaType } from '@cubo/core';
import { useEffect, useState } from 'react';
import { CatalogError } from '@/components/catalog-error';
import { CatalogLanding } from '@/components/catalog-landing';
import { catalog } from '@/lib/api';
import { useDocumentTitle } from '@/lib/use-document-title';

interface CatalogData {
  featured: MediaDetails | null;
  sections: { title: string; items: MediaSummary[] }[];
}

const COPY: Record<
  MediaType,
  { title: string; sections: [string, string, string, string] }
> = {
  movie: {
    title: 'Movies',
    sections: ['Trending movies', 'Now playing', 'Popular movies', 'Top rated movies'],
  },
  tv: {
    title: 'TV Shows',
    sections: ['Trending TV shows', 'On the air', 'Popular TV shows', 'Top rated TV shows'],
  },
};

export function CatalogPage({ mediaType }: { mediaType: MediaType }) {
  const copy = COPY[mediaType];
  useDocumentTitle(copy.title);
  const [data, setData] = useState<CatalogData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    (async () => {
      try {
        const [trending, current, popular, topRated] = await Promise.all([
          catalog.tmdb.trending(mediaType),
          catalog.tmdb.collection(mediaType, 'current'),
          catalog.tmdb.collection(mediaType, 'popular'),
          catalog.tmdb.collection(mediaType, 'top_rated'),
        ]);
        const featured = trending[0] ? await catalog.tmdb.details(mediaType, trending[0].id) : null;
        if (cancelled) return;
        const [trendingTitle, currentTitle, popularTitle, topRatedTitle] = copy.sections;
        setData({
          featured,
          sections: [
            { title: trendingTitle, items: trending },
            { title: currentTitle, items: current },
            { title: popularTitle, items: popular },
            { title: topRatedTitle, items: topRated },
          ],
        });
      } catch (reason) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : 'Could not load the catalogue.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mediaType, copy]);

  if (error) return <CatalogError message={error} />;
  if (!data) return <CatalogSkeleton />;
  return <CatalogLanding featured={data.featured} sections={data.sections} />;
}

function CatalogSkeleton() {
  return (
    <div className="animate-pulse">
      <div className="min-h-[32rem] bg-surface sm:min-h-[38rem] lg:min-h-[min(84vh,44rem)]" />
      <div className="shell space-y-14 pb-24 pt-14 sm:space-y-20 sm:pt-16">
        {[0, 1, 2, 3].map((row) => (
          <div key={row}>
            <div className="mb-5 h-4 w-40 rounded bg-surface" />
            <div className="flex gap-3 sm:gap-4">
              {Array.from({ length: 8 }, (_, i) => (
                <div
                  key={i}
                  className="aspect-[2/3] w-[8.5rem] shrink-0 rounded-xl bg-surface sm:w-[10.5rem]"
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
