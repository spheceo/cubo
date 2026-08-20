import { createClient, type MediaSummary } from '@cubo/core';
import { Hero, SectionRow } from '@cubo/ui';
import { useEffect, useState } from 'react';

const client = createClient({
  baseUrl: import.meta.env.VITE_API_BASE_URL ?? 'https://cubo.vercel.app',
});

export function App() {
  const [movies, setMovies] = useState<MediaSummary[]>([]);
  const [shows, setShows] = useState<MediaSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    void Promise.all([client.tmdb.trending('movie'), client.tmdb.trending('tv')])
      .then(([nextMovies, nextShows]) => {
        setMovies(nextMovies);
        setShows(nextShows);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load trending media');
      })
      .finally(() => {
        setLoading(false);
      });
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="max-w-7xl mx-auto px-6 pb-16">
      <header className="flex items-center py-6">
        <span className="text-2xl font-bold">
          cubo
          <span className="ml-1 inline-block h-2 w-2 rounded-full bg-amber-400 align-middle" />
        </span>
      </header>

      {loading ? (
        <div className="space-y-8">
          <div className="h-[28rem] animate-pulse rounded-lg bg-zinc-800" />
          <div className="h-6 w-48 animate-pulse rounded bg-zinc-800" />
          <div className="flex gap-4">
            {Array.from({ length: 6 }, (_, i) => (
              <div
                key={i}
                className="h-64 w-40 shrink-0 animate-pulse rounded-lg bg-zinc-800"
              />
            ))}
          </div>
        </div>
      ) : error ? (
        <div className="flex flex-col items-start gap-4 py-16">
          <p className="text-zinc-400">{error}</p>
          <button
            type="button"
            className="cursor-pointer rounded-full bg-amber-400 px-5 py-2 font-semibold text-black hover:bg-amber-300"
            onClick={load}
          >
            Retry
          </button>
        </div>
      ) : (
        <div className="space-y-10">
          {movies[0] ? <Hero item={movies[0]} /> : null}
          <SectionRow title="Trending Movies" items={movies} />
          <SectionRow title="Trending TV" items={shows} />
        </div>
      )}
    </div>
  );
}
