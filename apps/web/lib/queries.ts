import type { MediaType } from '@cubo/core';
import { QueryClient, queryOptions } from '@tanstack/react-query';
import { catalog } from './api';

/** Shared client: TMDB data barely changes minute to minute, so revisits and
 *  back-navigation render instantly from cache instead of refetching. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      gcTime: 30 * 60 * 1000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

export const tmdbQueries = {
  trending: (mediaType: MediaType) =>
    queryOptions({
      queryKey: ['tmdb', 'trending', mediaType],
      queryFn: () => catalog.tmdb.trending(mediaType),
    }),
  collection: (mediaType: MediaType, collection: 'popular' | 'top_rated' | 'current') =>
    queryOptions({
      queryKey: ['tmdb', 'collection', mediaType, collection],
      queryFn: () => catalog.tmdb.collection(mediaType, collection),
    }),
  details: (mediaType: MediaType, id: number) =>
    queryOptions({
      queryKey: ['tmdb', 'details', mediaType, id],
      queryFn: () => catalog.tmdb.details(mediaType, id),
    }),
  season: (showId: number, seasonNumber: number) =>
    queryOptions({
      queryKey: ['tmdb', 'season', showId, seasonNumber],
      queryFn: () => catalog.tmdb.season(showId, seasonNumber),
    }),
  search: (query: string) =>
    queryOptions({
      queryKey: ['tmdb', 'search', query],
      queryFn: () => catalog.tmdb.search(query),
    }),
};

export const streamQueries = {
  streams: (mediaType: MediaType, imdbId: string, season?: number, episode?: number) =>
    queryOptions({
      queryKey: ['streams', mediaType, imdbId, season ?? null, episode ?? null],
      queryFn: () => catalog.streams.get(mediaType, imdbId, season, episode),
      staleTime: 2 * 60 * 1000,
    }),
  subtitles: (mediaType: MediaType, imdbId: string, season?: number, episode?: number) =>
    queryOptions({
      queryKey: ['subtitles', mediaType, imdbId, season ?? null, episode ?? null],
      queryFn: () => catalog.subtitles.get(mediaType, imdbId, season, episode),
      staleTime: 30 * 60 * 1000,
    }),
};

const TITLE_HREF_RE = /^\/(movie|tv)\/(\d+)(?:\/)?$/;

/** Warms the details cache for a `/movie/:id` or `/tv/:id` href so the title
 *  page renders instantly after the click. Safe no-op for other hrefs. */
export function prefetchHref(href: string): void {
  const match = TITLE_HREF_RE.exec(href);
  if (!match) return;
  const mediaType = match[1] as MediaType;
  void queryClient.prefetchQuery(tmdbQueries.details(mediaType, Number(match[2])));
}
