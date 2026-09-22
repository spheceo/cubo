import type { Episode, SeasonSummary } from '@cubo/core';
import { isUpcomingAirDate } from './air-date';

export interface EpisodeRef {
  season: number;
  episode: number;
}

/** Where "Next episode" goes from a playing episode: the next aired entry in
 *  the same season, else the premiere of the next season that has aired.
 *  Unaired candidates are skipped — jumping to one lands on the "hasn't come
 *  out yet" screen. Null means the show ends here (or data is missing), and
 *  the prompt should not offer the action. */
export function resolveNextEpisode(
  seasons: SeasonSummary[] | undefined,
  seasonEpisodes: Episode[] | undefined,
  season: number,
  episode: number,
): EpisodeRef | null {
  const following = (seasonEpisodes ?? []).find(
    (entry) => entry.seasonNumber === season && entry.episodeNumber === episode + 1,
  );
  if (following && !isUpcomingAirDate(following.airDate)) {
    return { season, episode: episode + 1 };
  }
  const nextSeason = (seasons ?? [])
    .filter((entry) => entry.seasonNumber > season && entry.episodeCount > 0)
    .sort((a, b) => a.seasonNumber - b.seasonNumber)[0];
  if (nextSeason && !isUpcomingAirDate(nextSeason.airDate)) {
    return { season: nextSeason.seasonNumber, episode: 1 };
  }
  return null;
}
