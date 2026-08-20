import {
  stillUrl,
  type Episode,
  type SeasonSummary,
} from '@cubo/core';
import { useState } from 'react';
import { Link } from '@/components/link';
import { catalog } from '@/lib/api';

export function EpisodeList({
  showId,
  seasons,
  initialSeason,
  initialEpisodes,
}: {
  showId: number;
  seasons: SeasonSummary[];
  initialSeason: number;
  initialEpisodes: Episode[];
}) {
  const [season, setSeason] = useState(initialSeason);
  const [episodes, setEpisodes] = useState(initialEpisodes);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function selectSeason(next: number) {
    if (next === season) return;
    setSeason(next);
    setLoading(true);
    setError(null);
    catalog.tmdb
      .season(showId, next)
      .then(setEpisodes)
      .catch(() => setError('Could not load that season.'))
      .finally(() => setLoading(false));
  }

  return (
    <section>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
        <h2 className="text-base font-medium tracking-[-0.015em] text-fg sm:text-lg">Episodes</h2>
        {seasons.length > 1 ? (
          <label className="flex items-center gap-2 text-[0.78rem] text-muted">
            <span className="sr-only">Season</span>
            <select
              value={season}
              onChange={(event) => selectSeason(Number(event.target.value))}
              className="cursor-pointer rounded-full border border-line bg-ink px-3.5 py-1.5 text-[0.78rem] text-fg outline-none transition hover:border-line-strong"
            >
              {seasons.map((entry) => (
                <option key={entry.seasonNumber} value={entry.seasonNumber}>
                  {entry.name || `Season ${entry.seasonNumber}`}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {error ? <p className="text-sm text-muted">{error}</p> : null}

      <ul className={`m-0 list-none space-y-1 p-0 ${loading ? 'opacity-40' : ''}`}>
        {episodes.map((episode) => {
          const still = stillUrl(episode.stillPath);
          return (
            <li key={episode.id}>
              <Link
                href={`/watch/tv/${showId}?season=${episode.seasonNumber}&episode=${episode.episodeNumber}`}
                className="group flex gap-4 rounded-xl p-3 transition-colors hover:bg-surface"
              >
                <div className="relative aspect-video w-32 shrink-0 overflow-hidden rounded-lg bg-surface ring-1 ring-line sm:w-40">
                  {still ? (
                    <img
                      src={still}
                      alt=""
                      loading="lazy"
                      className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.04]"
                    />
                  ) : null}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[0.72rem] tabular-nums text-faint">
                      E{episode.episodeNumber}
                    </span>
                    <p className="truncate text-[0.85rem] font-medium text-fg/90 group-hover:text-fg">
                      {episode.name}
                    </p>
                  </div>
                  <p className="mt-1.5 line-clamp-2 text-[0.78rem] leading-relaxed text-faint">
                    {episode.overview || 'No description available.'}
                  </p>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>

      {!loading && episodes.length === 0 ? (
        <p className="text-sm text-muted">No episodes were found for this season.</p>
      ) : null}
    </section>
  );
}
