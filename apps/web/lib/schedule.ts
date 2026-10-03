/**
 * Release schedule for the shows the viewer is watching. A show counts as
 * "watching" once any episode is in the history, whether or not it is still
 * in Continue Watching — finishing an episode does not finish the show. Shows
 * with nothing left to air simply contribute no entries.
 */
import type { Episode, LibraryItem, MediaDetails } from '@cubo/core';
import { parseCalendarDate } from './air-date';

export interface ScheduleEntry {
  key: string;
  showId: number;
  title: string;
  backdropPath: string | null;
  posterPath: string | null;
  season: number;
  episode: number;
  name: string;
  /** `YYYY-MM-DD`, local calendar day. */
  airDate: string;
  date: Date;
}

/** TV shows in the history, most recently watched first. */
export function watchingShowIds(history: LibraryItem[] | undefined): number[] {
  const latest = new Map<number, number>();
  for (const item of history ?? []) {
    if (item.mediaType !== 'tv') continue;
    latest.set(item.mediaId, Math.max(latest.get(item.mediaId) ?? 0, item.lastWatchedAt));
  }
  return [...latest.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

export function startOfDay(date: Date): Date {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  return day;
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/** Local `YYYY-MM-DD` for a date. */
export function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * One entry per episode airing on or after `from`, sorted by day then show.
 * `episodes` is the season the show's next episode belongs to; when it is
 * missing (still loading, request failed) the next episode alone stands in.
 */
export function scheduleEntries(
  shows: { details: MediaDetails; episodes: Episode[] | undefined }[],
  from: Date,
): ScheduleEntry[] {
  const floor = startOfDay(from).getTime();
  const entries: ScheduleEntry[] = [];
  for (const { details, episodes } of shows) {
    const next = details.nextEpisode;
    if (!next) continue;
    const candidates =
      episodes && episodes.length > 0
        ? episodes.map((entry) => ({
            season: entry.seasonNumber,
            episode: entry.episodeNumber,
            name: entry.name,
            airDate: entry.airDate,
          }))
        : [
            {
              season: next.seasonNumber,
              episode: next.episodeNumber,
              name: next.name,
              airDate: next.airDate,
            },
          ];
    for (const candidate of candidates) {
      const date = parseCalendarDate(candidate.airDate);
      if (!date || date.getTime() < floor) continue;
      entries.push({
        key: `${details.id}:${candidate.season}:${candidate.episode}`,
        showId: details.id,
        title: details.title,
        backdropPath: details.backdropPath,
        posterPath: details.posterPath,
        season: candidate.season,
        episode: candidate.episode,
        name: candidate.name,
        airDate: dayKey(date),
        date,
      });
    }
  }
  return entries.sort(
    (a, b) =>
      a.date.getTime() - b.date.getTime() ||
      a.title.localeCompare(b.title) ||
      a.episode - b.episode,
  );
}

/** Entries bucketed by `dayKey`. */
export function entriesByDay(entries: ScheduleEntry[]): Map<string, ScheduleEntry[]> {
  const days = new Map<string, ScheduleEntry[]>();
  for (const entry of entries) {
    const bucket = days.get(entry.airDate);
    if (bucket) bucket.push(entry);
    else days.set(entry.airDate, [entry]);
  }
  return days;
}

/** Monday on or before `date`. */
export function startOfWeek(date: Date): Date {
  const day = startOfDay(date);
  return addDays(day, -((day.getDay() + 6) % 7));
}

/** Whole weeks (Monday first) covering the month that contains `month`. */
export function monthGrid(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const last = new Date(month.getFullYear(), month.getMonth() + 1, 0);
  const start = startOfWeek(first);
  const days: Date[] = [];
  for (let day = start; day <= last || days.length % 7 !== 0; day = addDays(day, 1)) {
    days.push(day);
  }
  return days;
}
