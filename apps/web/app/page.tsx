import type { MediaSummary, MediaType } from '@cubo/core';
import { Hero, SectionRow } from '@cubo/ui';

type TmdbTrendingItem = {
  id: number;
  title?: string;
  name?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
};

function normalize(item: TmdbTrendingItem, mediaType: MediaType): MediaSummary {
  return {
    id: item.id,
    mediaType,
    title: item.title ?? item.name ?? '',
    overview: item.overview ?? '',
    posterPath: item.poster_path ?? null,
    backdropPath: item.backdrop_path ?? null,
    releaseDate: item.release_date ?? item.first_air_date ?? '',
    voteAverage: item.vote_average ?? 0,
  };
}

async function fetchTrending(mediaType: MediaType): Promise<MediaSummary[]> {
  const response = await fetch(
    `https://api.themoviedb.org/3/trending/${mediaType}/week?api_key=${process.env.TMDB_API_KEY}`,
    { next: { revalidate: 3600 } },
  );
  const data = (await response.json()) as { results?: TmdbTrendingItem[] };
  return (data.results ?? []).map((item) => normalize(item, mediaType));
}

export default async function HomePage() {
  if (!process.env.TMDB_API_KEY) {
    return (
      <main className="flex min-h-screen items-center justify-center px-6">
        <p className="max-w-md text-center text-zinc-400">
          Add <code className="text-zinc-200">TMDB_API_KEY</code> to{' '}
          <code className="text-zinc-200">apps/web/.env.local</code> to load
          trending titles.
        </p>
      </main>
    );
  }

  const [movies, shows] = await Promise.all([
    fetchTrending('movie'),
    fetchTrending('tv'),
  ]);

  return (
    <div className="max-w-7xl mx-auto px-6 pb-16">
      <header className="py-8">
        <p className="text-2xl font-bold tracking-tight">
          cubo<span className="text-amber-400">.</span>
        </p>
      </header>
      {movies[0] ? <Hero item={movies[0]} /> : null}
      <div className="mt-10 space-y-10">
        <SectionRow title="Trending Movies" items={movies} />
        <SectionRow title="Trending TV" items={shows} />
      </div>
    </div>
  );
}
