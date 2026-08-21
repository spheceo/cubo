/** Calendar-day helpers for TMDB/Cinemeta air dates (`YYYY-MM-DD`). */

export function parseCalendarDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfToday(): Date {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today;
}

export function isUpcomingAirDate(airDate: string): boolean {
  const parsed = parseCalendarDate(airDate);
  if (!parsed) return false;
  return parsed.getTime() >= startOfToday().getTime();
}

/** "Airs Today", "Airs Tomorrow", "Airs Tuesday", or "Airs Aug 26". */
export function formatAirsLabel(airDate: string): string | null {
  const parsed = parseCalendarDate(airDate);
  if (!parsed) return null;
  const diffDays = Math.round((parsed.getTime() - startOfToday().getTime()) / 86_400_000);
  if (diffDays < 0) return null;
  if (diffDays === 0) return 'Airs Today';
  if (diffDays === 1) return 'Airs Tomorrow';
  if (diffDays < 7) {
    return `Airs ${parsed.toLocaleDateString(undefined, { weekday: 'long' })}`;
  }
  return `Airs ${parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

/** Season 1: "E2 Airs Sunday". Later seasons: "S2 E2 Airs Sunday". */
export function formatNextEpisodeLabel(episode: {
  seasonNumber: number;
  episodeNumber: number;
  airDate: string;
}): string | null {
  const when = formatAirsLabel(episode.airDate);
  if (!when) return null;
  const episodeLabel = `E${episode.episodeNumber} ${when}`;
  return episode.seasonNumber > 1 ? `S${episode.seasonNumber} ${episodeLabel}` : episodeLabel;
}
