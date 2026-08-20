/**
 * Source ranking for playback and previews. Part of the verified-working
 * playback pipeline (see AGENTS.md): direct-play files outrank remux-needing
 * files within a quality tier so the ffmpeg converter stays a fallback.
 */
import type { Stream } from '@cubo/core';
import { isBrowserPlayableStream, isPlayableStream } from './media-compatibility';

// 4K rarely plays smoothly over a torrent bridge, so 1080p leads the order.
const QUALITY_RANK: Record<string, number> = {
  '1080p': 0,
  '720p': 1,
  '2160p': 2,
  '480p': 3,
};

const AUDIO_LANGUAGE_HINTS: [string, RegExp][] = [
  ['en', /\b(?:eng|english)\b/i],
  ['fr', /\b(?:fre|fra|french|truefrench|vff|vfq)\b/i],
  ['es', /\b(?:spa|spanish|castellano|latino)\b/i],
  ['de', /\b(?:ger|deu|german|deutsch)\b/i],
  ['it', /\b(?:ita|italian)\b/i],
  ['pt', /\b(?:por|portuguese|brazilian)\b/i],
  ['ru', /\b(?:rus|russian)\b/i],
  ['ja', /\b(?:jpn|japanese)\b/i],
  ['ko', /\b(?:kor|korean)\b/i],
  ['hi', /\b(?:hin|hindi)\b/i],
  ['zh', /\b(?:chi|zho|chinese|mandarin)\b/i],
  ['ar', /\b(?:ara|arabic)\b/i],
];
const ORIGINAL_AUDIO_RE = /\b(?:vostfr|original[ ._-]?(?:audio|language))\b/i;
const MULTI_AUDIO_RE = /\b(?:multi|dual[ ._-]?audio|dubbed)\b/i;

function rank(stream: Stream): number {
  return QUALITY_RANK[stream.quality?.toLowerCase() ?? ''] ?? 4;
}

/** Buckets seeders so "plenty" sources compete on bitrate instead of raw swarm size. */
function seederBucket(seeders: number | null): number {
  const value = seeders ?? 0;
  if (value >= 50) return 2;
  if (value >= 10) return 1;
  return 0;
}

function audioLanguageRank(stream: Stream, nativeLanguage: string | null): number {
  if (!nativeLanguage) return 1;
  const native = nativeLanguage.toLowerCase();
  const hint = `${stream.name} ${stream.title} ${stream.filename ?? ''}`;
  if (ORIGINAL_AUDIO_RE.test(hint)) return 0;

  const nativeHint = AUDIO_LANGUAGE_HINTS.find(([code]) => code === native);
  if (nativeHint?.[1].test(hint)) return 0;
  if (MULTI_AUDIO_RE.test(hint)) return 2;
  if (AUDIO_LANGUAGE_HINTS.some(([code, pattern]) => code !== native && pattern.test(hint))) {
    return 3;
  }
  return 1;
}

/** What the current setup can play: `transcode` when the connected Core has
 *  ffmpeg, `hevc` when this browser decodes copy-remuxed HEVC. */
export interface PlaybackCapabilities {
  transcode: boolean;
  hevc: boolean;
}

/** Playable streams, best first: original-language audio (a dubbed release
 *  should never win the auto-pick), then preferred quality, then direct-play
 *  files (fully seekable, no converter), then a healthy swarm, then the
 *  larger file (higher bitrate). When the connected Core can transcode, MKV
 *  and exotic-audio sources join the pool as the fallback within each tier. */
export function rankStreams(
  streams: Stream[],
  capabilities: PlaybackCapabilities,
  nativeLanguage: string | null = null,
): Stream[] {
  return streams
    .filter((stream) => isPlayableStream(stream, capabilities.transcode, capabilities.hevc))
    .sort((a, b) => {
      const byLanguage =
        audioLanguageRank(a, nativeLanguage) - audioLanguageRank(b, nativeLanguage);
      if (byLanguage !== 0) return byLanguage;
      const byQuality = rank(a) - rank(b);
      if (byQuality !== 0) return byQuality;
      const byDirect =
        Number(isBrowserPlayableStream(b)) - Number(isBrowserPlayableStream(a));
      if (byDirect !== 0) return byDirect;
      const byBucket = seederBucket(b.seeders) - seederBucket(a.seeders);
      if (byBucket !== 0) return byBucket;
      const bySize = (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0);
      if (bySize !== 0) return bySize;
      return (b.seeders ?? 0) - (a.seeders ?? 0);
    });
}

/** Direct-play preview sources only. Prefer a healthy 720p/1080p swarm and,
 * among similarly available files, the smaller download so playback starts
 * quickly. Preview never enters Core's ffmpeg remux path. */
export function rankPreviewStreams(
  streams: Stream[],
  nativeLanguage: string | null = null,
): Stream[] {
  const direct = streams.filter(isBrowserPlayableStream);
  const goodQuality = direct.filter((stream) =>
    ['720p', '1080p'].includes(stream.quality?.toLowerCase() ?? ''),
  );
  const candidates = goodQuality.length > 0 ? goodQuality : direct;

  return candidates.sort((a, b) => {
    const byLanguage =
      audioLanguageRank(a, nativeLanguage) - audioLanguageRank(b, nativeLanguage);
    if (byLanguage !== 0) return byLanguage;
    const byBucket = seederBucket(b.seeders) - seederBucket(a.seeders);
    if (byBucket !== 0) return byBucket;
    const bySeeders = (b.seeders ?? 0) - (a.seeders ?? 0);
    if (bySeeders !== 0) return bySeeders;
    const bySize = (a.sizeBytes ?? Number.MAX_SAFE_INTEGER) -
      (b.sizeBytes ?? Number.MAX_SAFE_INTEGER);
    if (bySize !== 0) return bySize;
    return rank(a) - rank(b);
  });
}

export function streamKey(stream: Stream): string {
  return `${stream.infoHash}:${stream.fileIdx ?? 'auto'}`;
}
