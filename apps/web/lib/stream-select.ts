import type { Stream } from '@cubo/core';
import { isBrowserPlayableStream } from './media-compatibility';

// 4K rarely plays smoothly over a torrent bridge, so 1080p leads the order.
const QUALITY_RANK: Record<string, number> = {
  '1080p': 0,
  '720p': 1,
  '2160p': 2,
  '480p': 3,
};

function rank(stream: Stream): number {
  return QUALITY_RANK[stream.quality?.toLowerCase() ?? ''] ?? 4;
}

/** Browser-playable streams, best first: preferred quality, then most seeders. */
export function rankStreams(streams: Stream[]): Stream[] {
  return streams.filter(isBrowserPlayableStream).sort((a, b) => {
    const byQuality = rank(a) - rank(b);
    if (byQuality !== 0) return byQuality;
    return (b.seeders ?? 0) - (a.seeders ?? 0);
  });
}

export function streamKey(stream: Stream): string {
  return `${stream.infoHash}:${stream.fileIdx ?? 'auto'}`;
}

export function formatSize(bytes: number | null): string {
  if (bytes == null) return '';
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}
