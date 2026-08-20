import type { MediaDetails, MediaSummary } from '@cubo/core';
import { useEffect, useState } from 'react';
import { CatalogError } from '@/components/catalog-error';
import { FeaturedHero } from '@/components/featured-hero';
import { HomeLibraryRail } from '@/components/home-library-rail';
import { MediaRow } from '@/components/media-row';
import { MotionReveal } from '@/components/motion-reveal';
import { catalog } from '@/lib/api';
import { useDocumentTitle } from '@/lib/use-document-title';

interface HomeData {
  movies: MediaSummary[];
  shows: MediaSummary[];
  featured: MediaDetails | null;
}

export function HomePage() {
  useDocumentTitle(null);
  const [data, setData] = useState<HomeData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [movies, shows] = await Promise.all([
          catalog.tmdb.trending('movie'),
          catalog.tmdb.trending('tv'),
        ]);
        const featured = movies[0] ? await catalog.tmdb.details('movie', movies[0].id) : null;
        if (!cancelled) setData({ movies, shows, featured });
      } catch (reason) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : 'Could not load the catalogue.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <CatalogError message={error} />;
  if (!data) return <HomeSkeleton />;

  return (
    <main id="top">
      {data.featured ? <FeaturedHero item={data.featured} /> : null}
      <HomeLibraryRail />

      <div className="shell space-y-14 pb-28 pt-12 sm:space-y-20 sm:pt-16">
        <MotionReveal>
          <section id="movies" className="scroll-mt-24">
            <MediaRow title="Trending movies" items={data.movies} />
          </section>
        </MotionReveal>
        <MotionReveal>
          <section id="series" className="scroll-mt-24">
            <MediaRow title="Trending series" items={data.shows} />
          </section>
        </MotionReveal>
      </div>
    </main>
  );
}

function Row() {
  return (
    <div>
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
  );
}

function HomeSkeleton() {
  return (
    <div className="animate-pulse">
      <div className="min-h-[32rem] bg-surface sm:min-h-[38rem] lg:min-h-[min(84vh,44rem)]" />
      <div className="shell space-y-14 pb-24 pt-14 sm:space-y-20 sm:pt-16">
        <Row />
        <Row />
      </div>
    </div>
  );
}
