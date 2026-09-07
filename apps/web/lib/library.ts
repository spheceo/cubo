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

/** One card per title — always the last season/episode touched. */
export function continueWatchingItems(
  history: LibraryItem[] | undefined,
  mediaType?: MediaType,
): LibraryItem[] {
  return latestItemsByTitle(history, mediaType)
    .filter((item) => item.positionSeconds >= 30 && item.progress < 0.9)
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
