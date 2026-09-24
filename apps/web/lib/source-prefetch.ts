/**
 * Warms the source a viewer is about to play (the next episode near the end
 * of this one, the title page they are looking at) so its playback session
 * starts in about a second. Picks exactly what the watch screen would pick:
 * the remembered source when it is still eligible, else the top of the same
 * ranking. Core fetches only metadata and the file header, then parks the
 * torrent, so a wrong guess costs a few megabytes.
 */
import type { MediaType, Stream } from '@cubo/core';
import { buildMagnet, prefetchSource, type LocalEngineConnection } from './local-engine';
import { playbackKey } from './library';
import { supportsHevcRemux } from './media-compatibility';
import { queryClient, streamQueries } from './queries';
import { loadSource, preferSource } from './source-affinity';
import { isAutomaticSource, rankStreams } from './stream-select';

/** One warm-up per title per window: page revisits and re-renders are free. */
const PREFETCH_TTL_MS = 10 * 60_000;
const recent = new Map<string, number>();

export interface PrefetchTarget {
  mediaType: MediaType;
  mediaId: number;
  imdbId: string | null;
  title: string;
  originalLanguage: string | null;
  season?: number | null;
  episode?: number | null;
}

/** Automatic playback order for a title: eligible sources best first, the
 *  remembered one (if still eligible) at the front. The watch screen and
 *  the prefetcher share it so they agree on what plays. */
export function rankForPlayback(
  found: Stream[],
  saved: Stream | null,
  connection: Pick<LocalEngineConnection, 'transcode'> | null,
  target: Pick<PrefetchTarget, 'originalLanguage' | 'season' | 'episode'>,
): Stream[] {
  const candidates = saved
    ? [
        saved,
        ...found.filter(
          (stream) =>
            stream.infoHash !== saved.infoHash
            || (stream.fileIdx != null && stream.fileIdx !== saved.fileIdx),
        ),
      ]
    : found;
  const ranked = rankStreams(
    candidates,
    { transcode: connection?.transcode ?? false, hevc: supportsHevcRemux() },
    target.originalLanguage,
    target.season != null && target.episode != null
      ? { season: target.season, episode: target.episode }
      : null,
  ).filter((stream) => isAutomaticSource(stream, target.originalLanguage));
  return preferSource(ranked, saved);
}

export async function prefetchTitle(
  connection: LocalEngineConnection | null,
  target: PrefetchTarget,
): Promise<void> {
  if (!connection?.sessions || !target.imdbId) return;
  const key = playbackKey(target.mediaType, target.mediaId, target.season, target.episode);
  const now = Date.now();
  if ((recent.get(key) ?? 0) > now - PREFETCH_TTL_MS) return;
  recent.set(key, now);

  const found = await queryClient
    .fetchQuery(
      streamQueries.streams(
        target.mediaType,
        target.imdbId,
        target.season ?? undefined,
        target.episode ?? undefined,
      ),
    )
    .catch(() => [] as Stream[]);
  const choice = rankForPlayback(found, loadSource(key), connection, target)[0];
  if (!choice) return;
  prefetchSource(connection, {
    magnet: buildMagnet(choice),
    mediaKey: key,
    title: target.title,
    fileIndex: choice.fileIdx ?? null,
    hevc: supportsHevcRemux(),
  });
}
