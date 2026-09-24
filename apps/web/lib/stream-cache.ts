/**
 * The last source list seen for each title, kept in localStorage. Playback
 * normally waits on Torrentio for sources; when it is slow or down, the
 * saved list starts the race instead. Stale entries are harmless — the race
 * drops dead sources in seconds and the fresh list replaces the saved one.
 */
import type { MediaType, Stream } from '@cubo/core';
import { queryClient, streamQueries } from './queries';

const STORAGE_KEY = 'cubo.streams.v1';
const MAX_TITLES = 60;
/** How long a fresh lookup gets before the saved list is used instead. */
export const SLOW_LOOKUP_MS = 2_500;

type Saved = Record<string, { at: number; streams: Stream[] }>;

function storageKey(mediaType: MediaType, imdbId: string, season?: number, episode?: number) {
  return [mediaType, imdbId, season ?? '-', episode ?? '-'].join(':');
}

function readAll(): Saved {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Saved) : {};
  } catch {
    return {};
  }
}

export function loadStreams(key: string): Stream[] | null {
  const entry = readAll()[key];
  return Array.isArray(entry?.streams) && entry.streams.length > 0 ? entry.streams : null;
}

export function saveStreams(key: string, streams: Stream[]): void {
  if (streams.length === 0) return;
  try {
    const saved = readAll();
    delete saved[key];
    saved[key] = { at: Date.now(), streams };
    const entries = Object.entries(saved)
      .sort(([, a], [, b]) => a.at - b.at)
      .slice(-MAX_TITLES);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Quota or private mode: playback still works from the network.
  }
}

/** Fresh sources, or the saved list when the lookup fails, comes back
 *  empty, or takes longer than `SLOW_LOOKUP_MS`. */
export function fetchStreams(
  mediaType: MediaType,
  imdbId: string,
  season?: number,
  episode?: number,
): Promise<Stream[]> {
  const key = storageKey(mediaType, imdbId, season, episode);
  const fresh = queryClient
    .fetchQuery(streamQueries.streams(mediaType, imdbId, season, episode))
    .then((streams) => {
      saveStreams(key, streams);
      return streams;
    });
  const saved = loadStreams(key);
  if (!saved) return fresh.catch(() => [] as Stream[]);
  return Promise.race([
    fresh.then((streams) => (streams.length > 0 ? streams : saved)).catch(() => saved),
    new Promise<Stream[]>((resolve) => window.setTimeout(() => resolve(saved), SLOW_LOOKUP_MS)),
  ]);
}
