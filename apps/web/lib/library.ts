import {
  watchHref,
  type LibraryItem,
  type MediaDetails,
  type MediaType,
  type UpcomingEpisode,
  type WatchLaterItem,
} from '@cubo/core';
import { formatAirsLabel, parseCalendarDate } from './air-date';

export function playbackKey(
  mediaType: MediaType,
  mediaId: number,
  season?: number | null,
  episode?: number | null,
): string {
  return [mediaType, mediaId, season ?? '-', episode ?? '-'].join(':');
}

export function episodeLabel(season?: number | null, episode?: number | null): string | null {
  if (season == null || episode == null) return null;
  return `S${season} E${episode}`;
}

export function playButtonLabel(
  mediaType: MediaType,
  resume?: Pick<LibraryItem, 'season' | 'episode'> | null,
  firstSeason = 1,
): string {
  if (mediaType !== 'tv') return 'Watch Now';
  const current = episodeLabel(resume?.season, resume?.episode);
  return current ? `Continue ${current}` : `Watch ${episodeLabel(firstSeason, 1)}`;
}

/** Progress row for one season/episode, if the viewer has started it. */
export function historyForEpisode(
  history: LibraryItem[] | undefined,
  showId: number,
  season: number,
  episode: number,
): LibraryItem | undefined {
  return history?.find(
    (item) =>
      item.mediaType === 'tv' &&
      item.mediaId === showId &&
      item.season === season &&
      item.episode === episode,
  );
}

/** Most recently touched history row for a title. Earlier episodes stay stored. */
export function latestHistoryForTitle(
  history: LibraryItem[] | undefined,
  mediaType: MediaType,
  mediaId: number,
): LibraryItem | undefined {
  let latest: LibraryItem | undefined;
  for (const item of history ?? []) {
    if (item.mediaType !== mediaType || item.mediaId !== mediaId) continue;
    if (!latest || item.lastWatchedAt > latest.lastWatchedAt) latest = item;
  }
  return latest;
}

/** One row per title, always the last season/episode the viewer touched. */
export function latestItemsByTitle(
  history: LibraryItem[] | undefined,
  mediaType?: MediaType,
): LibraryItem[] {
  const latestByTitle = new Map<string, LibraryItem>();
  for (const item of history ?? []) {
    if (mediaType && item.mediaType !== mediaType) continue;
    const id = `${item.mediaType}:${item.mediaId}`;
    const current = latestByTitle.get(id);
    if (!current || item.lastWatchedAt > current.lastWatchedAt) {
      latestByTitle.set(id, item);
    }
  }
  return [...latestByTitle.values()].sort((a, b) => b.lastWatchedAt - a.lastWatchedAt);
}

/** Skip accidental opens (player start at 0, immediate back). */
export const CONTINUE_WATCHING_MIN_SECONDS = 5;
export const CONTINUE_WATCHING_COMPLETION_PROGRESS = 0.98;
export const CONTINUE_WATCHING_COMPLETION_REMAINING_SECONDS = 60;

/** Completion is deliberately based on the absolute tail of the title as
 * well as its ratio. This keeps a long film visible until its final minute,
 * and makes old rows with Core's former 90% flag behave sensibly. */
export function completedNearEnd(item: LibraryItem): boolean {
  return (
    item.progress >= CONTINUE_WATCHING_COMPLETION_PROGRESS &&
    item.durationSeconds - item.positionSeconds <= CONTINUE_WATCHING_COMPLETION_REMAINING_SECONDS
  );
}

/** How many Continue Watching cards a row shows. */
export const CONTINUE_WATCHING_LIMIT = 8;

/** Last season/episode touched per title, ignoring brief opens. A finished
 *  row is kept here: for a show it still decides what comes next. */
export function continueWatchingCandidates(
  history: LibraryItem[] | undefined,
  mediaType?: MediaType,
): LibraryItem[] {
  // A brief open must not replace a meaningful resume for the same title.
  // Completion is checked only after grouping so a completed current episode
  // still suppresses older abandoned episodes.
  return latestItemsByTitle(
    (history ?? []).filter((item) => item.positionSeconds >= CONTINUE_WATCHING_MIN_SECONDS),
    mediaType,
  ).filter((item) => item.durationSeconds > 0);
}

/** Show ids whose card depends on TMDB details: the episode touched last is
 *  finished, so the card moves on to whatever airs after it. */
export function finishedShowIds(candidates: LibraryItem[]): number[] {
  return candidates
    .filter((item) => item.mediaType === 'tv' && item.season != null && item.episode != null && completedNearEnd(item))
    .map((item) => item.mediaId);
}

export interface ContinueWatchingEntry {
  /** History row the card comes from (removal clears the whole title). */
  item: LibraryItem;
  /** `resume`: an unfinished title. `next`: the episode after a finished
   *  one has aired. `waiting`: caught up on a show that is still airing. */
  kind: 'resume' | 'next' | 'waiting';
  season: number | null;
  episode: number | null;
  href: string;
  /** 0–1; nothing watched yet for `next` and `waiting`. */
  progress: number;
  /** An episode past the finished one aired after the viewer finished it. */
  newEpisode: boolean;
  /** Line under the logo: "S1 E4", or "S1 E8 · Airs Thu, Oct 22". */
  label: string | null;
}

type EpisodeRef = { seasonNumber: number; episodeNumber: number };

function compareEpisodes(left: EpisodeRef, right: EpisodeRef): number {
  return left.seasonNumber - right.seasonNumber || left.episodeNumber - right.episodeNumber;
}

/** The episode after `season`/`episode` by the show's season list, aired or not. */
export function followingEpisode(
  details: MediaDetails,
  season: number,
  episode: number,
): EpisodeRef | null {
  const current = details.seasons.find((entry) => entry.seasonNumber === season);
  if (current && episode < current.episodeCount) {
    return { seasonNumber: season, episodeNumber: episode + 1 };
  }
  const later = details.seasons
    .filter((entry) => entry.seasonNumber > season)
    .sort((a, b) => a.seasonNumber - b.seasonNumber)[0];
  return later ? { seasonNumber: later.seasonNumber, episodeNumber: 1 } : null;
}

function hasAired(target: EpisodeRef, details: MediaDetails): boolean {
  if (details.lastEpisode) return compareEpisodes(target, details.lastEpisode) <= 0;
  return !details.nextEpisode || compareEpisodes(target, details.nextEpisode) < 0;
}

/** Shows that may still get episodes. Ended, canceled and unknown shows
 *  with nothing scheduled are done once their last episode is finished. */
function stillAiring(details: MediaDetails): boolean {
  if (details.nextEpisode) return true;
  return details.status === 'Returning Series' || details.status === 'In Production' || details.status === 'Planned';
}

function startOfDayMs(time: number): number {
  const day = new Date(time);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** The season the viewer is on got an episode after they finished theirs.
 *  Someone catching up on an older season gets no pill: what is new is a
 *  later season, not the episode on the card. */
function airedSince(
  last: UpcomingEpisode | null,
  finished: EpisodeRef,
  following: EpisodeRef,
  finishedAt: number,
): boolean {
  if (!last || compareEpisodes(last, finished) <= 0) return false;
  if (last.seasonNumber !== following.seasonNumber) return false;
  const aired = parseCalendarDate(last.airDate);
  return aired != null && aired.getTime() >= startOfDayMs(finishedAt);
}

/**
 * One card per title. Unfinished titles resume. A show whose last-touched
 * episode is finished moves on to the next aired episode, waits on its next
 * air date while it is still airing, and leaves the row once there is
 * nothing more to watch (finishing the final episode finishes the show, in
 * whatever order it was watched). Finished shows whose details have not
 * loaded yet are left out until they have. Cards with a new episode lead.
 */
export function continueWatchingEntries(
  candidates: LibraryItem[],
  detailsFor: (showId: number) => MediaDetails | undefined,
): ContinueWatchingEntry[] {
  const entries: ContinueWatchingEntry[] = [];
  for (const item of candidates) {
    if (!completedNearEnd(item)) {
      entries.push({
        item,
        kind: 'resume',
        season: item.season,
        episode: item.episode,
        href: item.watchHref,
        progress: item.progress,
        newEpisode: false,
        label: episodeLabel(item.season, item.episode),
      });
      continue;
    }
    if (item.mediaType !== 'tv' || item.season == null || item.episode == null) continue;
    const details = detailsFor(item.mediaId);
    if (!details) continue;
    const finished = { seasonNumber: item.season, episodeNumber: item.episode };
    const following = followingEpisode(details, item.season, item.episode);
    if (following && hasAired(following, details)) {
      entries.push({
        item,
        kind: 'next',
        season: following.seasonNumber,
        episode: following.episodeNumber,
        href: watchHref(details, following.seasonNumber, following.episodeNumber),
        progress: 0,
        newEpisode: airedSince(details.lastEpisode, finished, following, item.lastWatchedAt),
        label: episodeLabel(following.seasonNumber, following.episodeNumber),
      });
      continue;
    }
    if (!stillAiring(details)) continue;
    const next = details.nextEpisode;
    const when = next ? formatAirsLabel(next.airDate) : null;
    entries.push({
      item,
      kind: 'waiting',
      season: next?.seasonNumber ?? null,
      episode: next?.episodeNumber ?? null,
      href: item.detailHref,
      progress: 0,
      newEpisode: false,
      label: next && when
        ? `${episodeLabel(next.seasonNumber, next.episodeNumber)} · ${when}`
        : 'Caught up',
    });
  }
  // Stable: recency order holds within each group.
  return entries
    .sort((a, b) => Number(b.newEpisode) - Number(a.newEpisode))
    .slice(0, CONTINUE_WATCHING_LIMIT);
}

export function watchHistoryItems(
  history: LibraryItem[] | undefined,
): LibraryItem[] {
  return latestItemsByTitle(history).slice(0, 16);
}

export function watchLaterItem(details: MediaDetails): WatchLaterItem {
  const firstSeason = details.seasons[0]?.seasonNumber ?? 1;
  return {
    key: playbackKey(details.mediaType, details.id),
    mediaId: details.id,
    mediaType: details.mediaType,
    imdbId: details.imdbId,
    title: details.title,
    posterPath: details.posterPath,
    backdropPath: details.backdropPath,
    watchHref:
      details.mediaType === 'tv' ? watchHref(details, firstSeason, 1) : watchHref(details),
    detailHref: `/${details.mediaType}/${details.id}`,
    savedAt: 0,
  };
}
