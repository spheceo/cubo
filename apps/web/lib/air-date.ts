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

/** Whole calendar days from today to `date` (negative in the past). */
export function daysFromToday(date: Date): number {
  return Math.round((date.getTime() - startOfToday().getTime()) / 86_400_000);
}

/** "Oct 9", or "Oct 9, 2027" outside the current year. */
function formatShortDate(date: Date): string {
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** "Airs Today", "Airs Tomorrow", "Airs Fri, Oct 9", or "Airs Oct 16".
 *  A bare weekday is ambiguous — on a Saturday, "Friday" reads as
 *  yesterday — so anything past tomorrow carries its date. */
export function formatAirsLabel(airDate: string): string | null {
  const parsed = parseCalendarDate(airDate);
  if (!parsed) return null;
  const diffDays = daysFromToday(parsed);
  if (diffDays < 0) return null;
  if (diffDays === 0) return 'Airs Today';
  if (diffDays === 1) return 'Airs Tomorrow';
  if (diffDays < 7) {
    const weekday = parsed.toLocaleDateString(undefined, { weekday: 'short' });
    return `Airs ${weekday}, ${formatShortDate(parsed)}`;
  }
  return `Airs ${formatShortDate(parsed)}`;
}

/** Season 1: "E2 Airs Fri, Oct 9". Later seasons: "S2 E2 Airs Fri, Oct 9". */
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
