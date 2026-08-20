import { watchHref, type MediaDetails, type MediaType, type WatchLaterItem } from '@cubo/core';

export function playbackKey(
  mediaType: MediaType,
  mediaId: number,
  season?: number | null,
  episode?: number | null,
): string {
  return [mediaType, mediaId, season ?? '-', episode ?? '-'].join(':');
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
