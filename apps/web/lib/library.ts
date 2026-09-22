import {
  watchHref,
  type LibraryItem,
  type MediaDetails,
  type MediaType,
  type WatchLaterItem,
} from '@cubo/core';

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

/** One card per title — always the last season/episode touched. */
export function continueWatchingItems(
  history: LibraryItem[] | undefined,
  mediaType?: MediaType,
): LibraryItem[] {
  // A brief open must not replace a meaningful resume for the same title.
  // Completion is checked only after grouping so a completed current episode
  // still suppresses older abandoned episodes.
  return latestItemsByTitle(
    (history ?? []).filter((item) => item.positionSeconds >= CONTINUE_WATCHING_MIN_SECONDS),
    mediaType,
  )
    .filter((item) =>
      item.durationSeconds > 0 &&
      !completedNearEnd(item),
    )
    .slice(0, 8);
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
