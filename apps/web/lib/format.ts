import type { MediaSummary } from '@cubo/core';

/** "2h 15m" style runtime label, or null when the runtime is unknown. */
export function formatRuntime(minutes: number | null): string | null {
  if (!minutes) return null;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours > 0 ? `${hours}h ` : ''}${rest > 0 ? `${rest}m` : ''}`.trim();
}

/** Adapts a library/watch-later record to the MediaSummary shape MediaCard
 *  renders. Overview/date/rating are absent from library records on purpose. */
export function asMediaSummary(item: {
  mediaId: number;
  mediaType: MediaSummary['mediaType'];
  title: string;
  posterPath: string | null;
  backdropPath: string | null;
}): MediaSummary {
  return {
    id: item.mediaId,
    mediaType: item.mediaType,
    title: item.title,
    overview: '',
    posterPath: item.posterPath,
    backdropPath: item.backdropPath,
    releaseDate: '',
    voteAverage: 0,
  };
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';

  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  const paddedSeconds = String(secs).padStart(2, '0');
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${paddedSeconds}`
    : `${minutes}:${paddedSeconds}`;
}
